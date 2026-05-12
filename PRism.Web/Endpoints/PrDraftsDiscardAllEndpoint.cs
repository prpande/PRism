using Microsoft.Extensions.Logging;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Logging;

namespace PRism.Web.Endpoints;

// S5 PR3 — POST /api/pr/{ref}/drafts/discard-all (spec § 13). Closed/merged-PR bulk-discard:
// always clears the session locally; if a pendingReviewId was set, fires a best-effort courtesy
// deletePullRequestReview that does NOT block the 200. The closed/merged constraint is enforced
// client-side (the button only renders on closed/merged PRs); the endpoint trusts that and the
// `cache.IsSubscribed` authz (spec § 13.3).
internal static class PrDraftsDiscardAllEndpoint
{
    private static readonly string[] DiscardedFields = { "draft-comments", "draft-replies", "draft-summary", "draft-verdict", "draft-verdict-status", "pending-review" };

    private static readonly Action<ILogger, string, object?, string, Exception?> s_courtesyDeleteFailed =
        LoggerMessage.Define<string, object?, string>(LogLevel.Warning, new EventId(0, "BulkDiscardCourtesyDeleteFailed"),
            "Bulk-discard courtesy DeletePendingReview failed for {SessionKey} pendingReviewId={PendingReviewId}: {Message}");

    public static IEndpointRouteBuilder MapPrDraftsDiscardAllEndpoint(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/drafts/discard-all", DiscardAllAsync);
        return app;
    }

    private static async Task<IResult> DiscardAllAsync(
        string owner, string repo, int number,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();
        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before discarding."), statusCode: StatusCodes.Status401Unauthorized);

        string? pendingToDelete = null;
        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing)) return state;
            pendingToDelete = existing.PendingReviewId;
            var cleared = existing with
            {
                DraftComments = Array.Empty<DraftComment>(),
                DraftReplies = Array.Empty<DraftReply>(),
                DraftSummaryMarkdown = null,
                DraftVerdict = null,
                DraftVerdictStatus = DraftVerdictStatus.Draft,
                PendingReviewId = null,
                PendingReviewCommitOid = null,
            };
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct).ConfigureAwait(false);

        bus.Publish(new StateChanged(prRef, DiscardedFields, SourceTabId: null));

        // Courtesy delete — best-effort; never blocks the 200. On failure, log (scrubbing the
        // pendingReviewId) and publish submit-orphan-cleanup-failed so the frontend toasts.
        if (!string.IsNullOrEmpty(pendingToDelete))
        {
            try
            {
                await submitter.DeletePendingReviewAsync(prRef, pendingToDelete, ct).ConfigureAwait(false);
            }
#pragma warning disable CA1031 // courtesy cleanup is best-effort by design — a failure is reported, not fatal
            catch (Exception ex)
            {
                // Pass the blocked field name explicitly (not nameof(local)) so the scrubber redacts it.
                s_courtesyDeleteFailed(
                    loggerFactory.CreateLogger("PRism.Web.Endpoints.PrDraftsDiscardAllEndpoint"),
                    sessionKey,
                    SensitiveFieldScrubber.Scrub("pendingReviewId", pendingToDelete),
                    ex.Message,
                    null);
                bus.Publish(new SubmitOrphanCleanupFailedBusEvent(prRef));
            }
#pragma warning restore CA1031
        }

        return Results.Ok();
    }
}
