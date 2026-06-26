using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
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
        IActivePrBatchReader batchReader,
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

            // Phase 1.5: head-shift guard — runs OUTSIDE store.UpdateAsync (it may make a GitHub
            // call, which must never run inside the brief apply gate) and AFTER Phase 1 reconcile
            // (verify the head as late as possible before the apply, keeping the window the guard
            // protects tight — #611). Every refusal returns here, BEFORE UpdateAsync, so no refusal
            // writes a tab stamp or reaches bus.Publish (the apply transform is the only writer of
            // either). See ResolveHeadShiftRefusalAsync + docs/specs/2026-06-26-634-...-design.md.
            if (await ResolveHeadShiftRefusalAsync(activePrCache, batchReader, prRef, request.HeadSha, ct)
                    .ConfigureAwait(false) is { } refusal)
                return refusal;

            // Phase 2: apply (gate held briefly). The head was verified above; UpdateAsync now does
            // the apply only. The in-transform TryGetValue re-checks session existence in case a
            // concurrent delete landed between Phase 1 and here (→ updatedSession null → 404).
            ReviewSessionState? updatedSession = null;
            await store.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(refKey, out var current))
                    return state;

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

            // Save the frontend a round-trip by returning the updated DTO directly. We
            // captured `updatedSession` out of the transform — avoids a second LoadAsync
            // (saves an fs round-trip + a `_gate` acquisition) and removes the latent
            // KeyNotFoundException that the previous `stateAfter.Reviews.Sessions[refKey]`
            // would have thrown if a future code path ever deletes a session between the
            // transform's commit and a re-LoadAsync. Today no such path exists; the
            // captured-session form is defensive against that future and simpler.
            // updatedSession is null only if the apply transform's TryGetValue missed — the session
            // was deleted between Phase 1's LoadAsync and the Phase 2 apply. That window now spans the
            // head-shift guard's GitHub read (#634), so a concurrent delete is rare-but-reachable
            // rather than purely theoretical; either way it degrades cleanly to a 404.
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

    // Head-shift guard (#611 cold cache + #634 diverged). Returns a 409 IResult to refuse the
    // reload, or null to proceed to the apply. Extracted from PostReload so the happy path reads
    // reconcile → guard → apply → publish; MUST run outside store.UpdateAsync (it may make a
    // GitHub call) and after Phase 1 reconcile (verify the head as late as possible).
    private static async Task<IResult?> ResolveHeadShiftRefusalAsync(
        IActivePrCache activePrCache,
        IActivePrBatchReader batchReader,
        PrReference prRef,
        string requestHeadSha,
        CancellationToken ct)
    {
        // Cold cache: the poller hasn't populated a snapshot for this PR yet (subscribe→poll race) or
        // it was cleared by POST /api/auth/replace. We cannot verify requestHeadSha against a known-good
        // head, so we must NOT reconcile against an unverified head (#611) — a stale client head would
        // silently corrupt draft state. GetCurrent != null is the true "first poll completed" signal —
        // a STRONGER precondition than IsSubscribed (true after subscribe but before the first poll).
        var cached = activePrCache.GetCurrent(prRef);
        if (cached is null)
            return Results.Json(new ReloadHeadUnverifiedResponse(), statusCode: StatusCodes.Status409Conflict);

        // Matching head: the cache agrees with the client → proceed to the apply (the happy path; no
        // GitHub call). This is also the only diverged-path exit that does NOT consult GitHub.
        if (cached.HeadSha == requestHeadSha)
            return null;

        // Diverged: the cache disagrees with the client head. The cache is NOT authoritative — it can
        // LAG the client (both are independent GitHub reads), so trusting it blindly would tell the
        // frontend to retry against a STALER head (#634). Consult GitHub for the actual current head via
        // the SAME GraphQL seam the poller uses to populate the cache (IActivePrBatchReader) — a different
        // transport (REST PollActivePrAsync) would expose us to GitHub's REST-vs-GraphQL replication skew.
        ActivePrPollSnapshot? authoritative = null;
        try
        {
            var batch = await batchReader.PollBatchAsync(new[] { prRef }, ct).ConfigureAwait(false);
            batch.TryGetValue(prRef, out authoritative);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw; // genuine request cancellation — surface it, don't mask it as a fallback
        }
#pragma warning disable CA1031 // any read failure degrades to the cached head — see comment
        catch (Exception)
        {
            // ANY authoritative-read failure — rate-limit, transport (HttpRequestException), or poison
            // payload (JsonException) — leaves `authoritative` null → fall back to the cached head below.
            // Mirrors ActivePrPoller's whole-tick-abort handling of this exact PollBatchAsync call
            // (retain last-known, never throw). Catching ONLY RateLimitExceededException here would
            // introduce a NEW 500 on the common force-push reload: for a zero-draft session Phase 1's
            // reconcile makes no GitHub call, so this is the ONLY external read and a transport blip
            // would 500 what was previously a 409 (#634 preflight finding).
        }
#pragma warning restore CA1031

        // The retry target is GitHub's authoritative head when we got one; otherwise we degrade to the
        // cached head (the prior behavior — no worse than the status quo, self-heals on the next poll,
        // and avoids a new 500 that would invite frantic re-clicks under rate-limit). When the chosen
        // target equals the client head, the client was current and the cache merely lagged → proceed.
        var retryHead = authoritative is null || string.IsNullOrEmpty(authoritative.HeadSha)
            ? cached.HeadSha
            : authoritative.HeadSha;
        return retryHead == requestHeadSha
            ? null
            : Results.Json(new ReloadStaleHeadResponse(retryHead), statusCode: StatusCodes.Status409Conflict);
    }
}
