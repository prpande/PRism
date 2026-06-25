using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static class PrReloadEndpoints
{
    private static readonly IReadOnlyList<string> ReloadFieldsTouched =
        new[] { "draft-comments", "draft-replies", "draft-verdict-status" };

    // PoC scope: per-PR SemaphoreSlim entries accumulate one per distinct prRef seen
    // during the server lifetime and are never removed. For the single-user local app
    // this is negligible (few unique PRs). For a hosted future, add a periodic eviction
    // pass keyed on last-acquired timestamp. (Recorded in deferrals — "[Defer]
    // PerPrSemaphores shrink / eviction in PrReloadEndpoints".)
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> PerPrSemaphores = new();

    internal sealed record ReloadRequest(string HeadSha);

    // The frontend's parseReloadConflictKind (api/draft.ts) discriminates 409
    // responses by the `error` field — same shape as the inline 409
    // reload-in-progress response above. Without this field the response is
    // unrecognized and the auto-retry path in useReconcile (S4 PR7 Task 46)
    // never fires.
    internal sealed record ReloadStaleHeadResponse(string CurrentHeadSha)
    {
        public string Error { get; } = "reload-stale-head";
    }

    // Cold/unverifiable-head reload response (#611). When the active-PR cache has no snapshot for
    // this PR, the head-shift guard cannot verify request.HeadSha against a known head, so the
    // reconcile is refused with this retryable 409 rather than running against an unverified head.
    // Distinct from ReloadStaleHeadResponse: there is no currentHeadSha to retry with (we don't
    // know the current head). The frontend's parseReloadConflictKind (api/draft.ts) doesn't
    // recognize this `error` value, so useReconcile surfaces the generic retry banner — the
    // intended fail-safe degrade until a follow-up adds bespoke handling.
    internal sealed record ReloadHeadUnverifiedResponse
    {
        public string Error { get; } = "reload-head-unverified";
    }

    public static IEndpointRouteBuilder MapPrReloadEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/reload", PostReload);
        return app;
    }

    private static async Task<IResult> PostReload(
        string owner, string repo, int number,
        ReloadRequest? request,
        HttpContext httpContext,
        IAppStateStore store,
        IPrReader reviewService,
        IActivePrCache activePrCache,
        IReviewEventBus bus,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        if (request is null)
            return Results.BadRequest(new { error = "request-body-missing" });

        var prRef = new PrReference(owner, repo, number);
        var refKey = prRef.ToString();
        var sourceTabId = httpContext.Request.Headers[TabStamps.TabIdHeader].FirstOrDefault();

        // Tab id validation (spec § 3) — reload is a write site and must reject missing /
        // out-of-allowlist tab ids before any state mutation. Distinct /reload/tab-id-missing
        // 422 (vs the head-sha-missing 400 / sha-format-invalid 422 below) so the frontend can
        // surface the "stale browser tab" remedy independently of head-sha failures.
        if (string.IsNullOrEmpty(sourceTabId) || !PrDetailEndpoints.TabIdAllowlistRegex().IsMatch(sourceTabId))
            return Results.UnprocessableEntity(new { error = "reload-tab-id-missing" });

        // SECURITY: validate headSha presence + format before touching state. The null
        // guard runs first because System.Text.Json can deserialize `{}` or
        // `{"headSha": null}` into a `ReloadRequest` with `HeadSha = null` despite the
        // non-nullable record declaration; `Regex.IsMatch(null)` would throw
        // ArgumentNullException → 500 instead of returning 400.
        if (string.IsNullOrEmpty(request.HeadSha))
            return Results.BadRequest(new { error = "head-sha-missing" });
        if (!SharedRegexes.Sha40().IsMatch(request.HeadSha) && !SharedRegexes.Sha64().IsMatch(request.HeadSha))
            return Results.UnprocessableEntity(new { error = "sha-format-invalid" });

        var sem = PerPrSemaphores.GetOrAdd(refKey, _ => new SemaphoreSlim(1, 1));
        if (!await sem.WaitAsync(0, ct).ConfigureAwait(false))
            return Results.Conflict(new { error = "reload-in-progress" });

        try
        {
            // Phase 1: reconcile (no _gate held). The pipeline reads the session captured
            // from a snapshot LoadAsync, so a concurrent PUT /draft writing through _gate
            // can't tear our reconciled view — the pipeline operates against an immutable
            // record graph.
            var stateBefore = await store.LoadAsync(ct).ConfigureAwait(false);
            if (!stateBefore.Reviews.Sessions.TryGetValue(refKey, out var session))
                return Results.NotFound(new { error = "session-not-found" });

            var fileSource = new ReviewServiceFileContentSource(reviewService, prRef);
            var pipeline = new DraftReconciliationPipeline(loggerFactory.CreateLogger<DraftReconciliationPipeline>());
            var result = await pipeline.ReconcileAsync(
                session, request.HeadSha, fileSource, ct,
                renames: null, deletedPaths: null,
                // Pass the validated tab id into the pipeline so the override / verdict
                // head-shift checks use the caller's own stamp (spec § 5.4 branch 1).
                callerTabId: sourceTabId).ConfigureAwait(false);

            // Phase 2: apply (gate held briefly). Head-shift detection compares the
            // request's headSha against the active-PR cache's current head (populated by
            // ActivePrPoller). If they diverge, the poller has observed a newer head
            // between Phase 1's read and this Phase 2 apply — return 409 with the current
            // sha so the frontend can auto-retry (S4 Task 46).
            string? currentHeadShaForRetry = null;
            bool headUnverified = false;
            ReviewSessionState? updatedSession = null;
            await store.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(refKey, out var current))
                    return state;

                // Head-shift guard. The active-PR cache snapshot (populated by ActivePrPoller) is the
                // only VERIFIED view of the PR's current head; request.HeadSha is client-supplied.
                var cached = activePrCache.GetCurrent(prRef);
                if (cached is null)
                {
                    // Cold cache: the poller hasn't populated a snapshot for this PR yet (subscribe→poll
                    // race) or it was cleared by POST /api/auth/replace. We cannot verify request.HeadSha
                    // against a known-good head, so we must NOT fall through and reconcile against an
                    // unverified head (#611) — a stale client head would silently corrupt draft state.
                    // Signal a retryable conflict instead; the frontend retries once the next poll lands.
                    // GetCurrent != null is the true "first poll completed" signal — a STRONGER precondition
                    // than IsSubscribed, which is true after subscribe but before the first poll. Returns
                    // BEFORE the tab-stamp write below (no stamp written), and the post-transform
                    // headUnverified check short-circuits to a 409 before bus.Publish is reached, so the
                    // cold path emits no StateChanged.
                    headUnverified = true;
                    return state;
                }
                if (cached.HeadSha != request.HeadSha)
                {
                    currentHeadShaForRetry = cached.HeadSha;
                    return state;
                }

                // Left-join the reconciled outcomes onto the live current.DraftComments —
                // not a Select over result.Drafts. Two reasons (preflight Critical findings
                // 1 + 2 against the original Select-over-result implementation):
                //  - Concurrent PUT /draft DELETION between Phase 1 and Phase 2: the
                //    reconciled draft id no longer exists in `current`. A `Select(r =>
                //    current.DraftComments.First(...))` throws InvalidOperationException
                //    inside the transform — propagates to the user as a 500.
                //  - Concurrent PUT /draft ADDITION: the new draft is in `current` but
                //    NOT in `result.Drafts`. A Select over result.Drafts would silently
                //    drop the new draft when we replace `current.DraftComments` with the
                //    reconciled subset — data loss.
                // The left-join shape (iterate current; lookup reconciled outcome by id;
                // apply when present, keep original when absent) handles both cases
                // correctly: deletions fall out of the iteration naturally, additions
                // pass through unchanged.
                var draftOutcomesById = result.Drafts.ToDictionary(r => r.Id, r => r);
                var updatedDrafts = current.DraftComments.Select(orig =>
                {
                    if (!draftOutcomesById.TryGetValue(orig.Id, out var r))
                        return orig;
                    return orig with
                    {
                        FilePath = r.ResolvedFilePath ?? orig.FilePath,
                        LineNumber = r.ResolvedLineNumber ?? orig.LineNumber,
                        AnchoredSha = r.ResolvedAnchoredSha ?? orig.AnchoredSha,
                        Status = r.Status,
                        IsOverriddenStale = r.IsOverriddenStale
                    };
                }).ToList();

                var replyOutcomesById = result.Replies.ToDictionary(r => r.Id, r => r);
                var updatedReplies = current.DraftReplies.Select(orig =>
                {
                    if (!replyOutcomesById.TryGetValue(orig.Id, out var r))
                        return orig;
                    return orig with { Status = r.Status, IsOverriddenStale = r.IsOverriddenStale };
                }).ToList();

                var newVerdictStatus = result.VerdictOutcome == VerdictReconcileOutcome.NeedsReconfirm
                    ? DraftVerdictStatus.NeedsReconfirm
                    : current.DraftVerdictStatus;

                // Per-tab stamp write — sourceTabId was validated against TabIdAllowlistRegex
                // at the top of PostReload, so it's safe to use as a state-store key. The
                // TabStamps.MaxTabStamps cap mirrors the mark-viewed write site (spec § 5.2):
                // eviction by oldest stamp.
                var tabStamps = TabStamps.Write(current.TabStamps, sourceTabId, request.HeadSha, DateTime.UtcNow);
                var updated = current with
                {
                    DraftComments = updatedDrafts,
                    DraftReplies = updatedReplies,
                    DraftVerdictStatus = newVerdictStatus,
                    TabStamps = tabStamps
                };
                updatedSession = updated;
                return state.WithSession(refKey, updated);
            }, ct).ConfigureAwait(false);

            if (headUnverified)
                return Results.Json(
                    new ReloadHeadUnverifiedResponse(),
                    statusCode: StatusCodes.Status409Conflict);

            if (currentHeadShaForRetry is not null)
                return Results.Json(
                    new ReloadStaleHeadResponse(currentHeadShaForRetry),
                    statusCode: StatusCodes.Status409Conflict);

            // Save the frontend a round-trip by returning the updated DTO directly. We
            // captured `updatedSession` out of the transform — avoids a second LoadAsync
            // (saves an fs round-trip + a `_gate` acquisition) and removes the latent
            // KeyNotFoundException that the previous `stateAfter.Reviews.Sessions[refKey]`
            // would have thrown if a future code path ever deletes a session between the
            // transform's commit and a re-LoadAsync. Today no such path exists; the
            // captured-session form is defensive against that future and simpler.
            // updatedSession is null only if the transform's TryGetValue at line 89-90
            // missed (session vanished between Phase 1 and Phase 2 — also currently
            // unreachable but defended against).
            if (updatedSession is null)
                return Results.NotFound(new { error = "session-not-found" });

            // Publish StateChanged outside _gate per spec § 4.4. Gated on
            // `updatedSession is not null` so the 404 path emits no event — matches
            // the "don't publish on error/no-op" policy in PrDraftEndpoints.PutDraft.
            // Reload always touches the three reconciled fields even when the result is
            // a no-op (e.g., session had zero drafts) — the frontend treats StateChanged
            // as a "trigger refetch" signal regardless of which fields changed.
            bus.Publish(new StateChanged(prRef, ReloadFieldsTouched, sourceTabId));
            return Results.Ok(PrDraftEndpoints.MapToDto(updatedSession));
        }
        finally
        {
            sem.Release();
        }
    }
}
