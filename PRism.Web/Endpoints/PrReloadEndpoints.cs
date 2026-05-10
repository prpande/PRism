using System.Collections.Concurrent;
using System.Text.RegularExpressions;
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
    private static readonly Regex Sha40 = new("^[0-9a-f]{40}$", RegexOptions.Compiled);
    private static readonly Regex Sha64 = new("^[0-9a-f]{64}$", RegexOptions.Compiled);

    private static readonly IReadOnlyList<string> ReloadFieldsTouched =
        new[] { "draft-comments", "draft-replies", "draft-verdict-status" };

    // PoC scope: per-PR SemaphoreSlim entries accumulate one per distinct prRef seen
    // during the server lifetime and are never removed. For the single-user local app
    // this is negligible (few unique PRs). For a hosted future, add a periodic eviction
    // pass keyed on last-acquired timestamp. (Recorded in deferrals — "[Defer]
    // PerPrSemaphores shrink / eviction in PrReloadEndpoints".)
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> PerPrSemaphores = new();

    internal sealed record ReloadRequest(string HeadSha);
    internal sealed record ReloadStaleHeadResponse(string CurrentHeadSha);

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
        IReviewService reviewService,
        IActivePrCache activePrCache,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        if (request is null)
            return Results.BadRequest(new { error = "request-body-missing" });

        var prRef = new PrReference(owner, repo, number);
        var refKey = prRef.ToString();
        var sourceTabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();

        // SECURITY: validate headSha format before touching state — mirrors
        // PrDraftEndpoints.NewDraftComment AnchoredSha validation per spec § 4.2.
        if (!Sha40.IsMatch(request.HeadSha) && !Sha64.IsMatch(request.HeadSha))
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
            var pipeline = new DraftReconciliationPipeline();
            var result = await pipeline.ReconcileAsync(
                session, request.HeadSha, fileSource, ct,
                renames: null, deletedPaths: null).ConfigureAwait(false);

            // Phase 2: apply (gate held briefly). Head-shift detection compares the
            // request's headSha against the active-PR cache's current head (populated by
            // ActivePrPoller). If they diverge, the poller has observed a newer head
            // between Phase 1's read and this Phase 2 apply — return 409 with the current
            // sha so the frontend can auto-retry (S4 Task 46).
            string? currentHeadShaForRetry = null;
            await store.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(refKey, out var current))
                    return state;

                var cached = activePrCache.GetCurrent(prRef);
                if (cached is not null && cached.HeadSha != request.HeadSha)
                {
                    currentHeadShaForRetry = cached.HeadSha;
                    return state;
                }

                var updatedDrafts = result.Drafts.Select(r =>
                {
                    var orig = current.DraftComments.First(d => d.Id == r.Id);
                    return orig with
                    {
                        FilePath = r.ResolvedFilePath ?? orig.FilePath,
                        LineNumber = r.ResolvedLineNumber ?? orig.LineNumber,
                        AnchoredSha = r.ResolvedAnchoredSha ?? orig.AnchoredSha,
                        Status = r.Status,
                        IsOverriddenStale = r.IsOverriddenStale
                    };
                }).ToList();

                var updatedReplies = result.Replies.Select(r =>
                {
                    var orig = current.DraftReplies.First(rp => rp.Id == r.Id);
                    return orig with { Status = r.Status, IsOverriddenStale = r.IsOverriddenStale };
                }).ToList();

                var newVerdictStatus = result.VerdictOutcome == VerdictReconcileOutcome.NeedsReconfirm
                    ? DraftVerdictStatus.NeedsReconfirm
                    : current.DraftVerdictStatus;

                var updated = current with
                {
                    DraftComments = updatedDrafts,
                    DraftReplies = updatedReplies,
                    DraftVerdictStatus = newVerdictStatus,
                    LastViewedHeadSha = request.HeadSha
                };

                var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
                {
                    [refKey] = updated
                };
                return state with { Reviews = state.Reviews with { Sessions = sessions } };
            }, ct).ConfigureAwait(false);

            if (currentHeadShaForRetry is not null)
                return Results.Json(
                    new ReloadStaleHeadResponse(currentHeadShaForRetry),
                    statusCode: StatusCodes.Status409Conflict);

            // Publish StateChanged outside _gate per spec § 4.4. Reload always touches
            // the three reconciled fields even when the result is a no-op (e.g., session
            // had zero drafts) — the frontend treats StateChanged as a "trigger refetch"
            // signal regardless of which fields changed.
            bus.Publish(new StateChanged(prRef, ReloadFieldsTouched, sourceTabId));

            // Save the frontend a round-trip by returning the updated DTO directly.
            var stateAfter = await store.LoadAsync(ct).ConfigureAwait(false);
            var session2 = stateAfter.Reviews.Sessions[refKey];
            return Results.Ok(PrDraftEndpoints.MapToDto(session2));
        }
        finally
        {
            sem.Release();
        }
    }
}
