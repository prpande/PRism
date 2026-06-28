using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Logging;
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

// S5 PR3 — POST /api/pr/{ref}/drafts/discard-all (spec § 13). Closed/merged-PR bulk-discard:
// always clears the session locally; if a pendingReviewId was set, fires a best-effort courtesy
// deletePullRequestReview that does NOT block the 200 (spec § 13.2 step 3 — "logged but not
// awaited as a blocker"). The closed/merged constraint is enforced client-side (the button only
// renders on closed/merged PRs); the endpoint trusts that and the `cache.IsSubscribed` authz
// (spec § 13.3).
internal static class PrDraftsDiscardAllEndpoint
{
    private static readonly string[] DiscardedFields = { "draft-comments", "draft-replies", "draft-verdict", "draft-verdict-status", "pending-review" };

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
        SubmitLockRegistry lockRegistry,
        SubmitCancellationRegistry cancellationRegistry,
        ILoggerFactory loggerFactory,
        IHostApplicationLifetime appLifetime,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();
        if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before discarding.") is { } notSubscribed)
            return notSubscribed;

        // #605 item A — take the per-PR submit lock before wiping the session, mirroring
        // /submit/discard (PrSubmitEndpoints.DiscardOwnPendingReviewAsync). Without this, a
        // concurrent in-flight /submit (or /comment/post) could re-materialise a half-populated
        // pending review on top of the local clear. Cancel any in-flight pipeline first (idempotent
        // no-op when idle), then wait for it to release the lock; 504 if it does not within the
        // window so the caller can retry rather than racing the pipeline.
        cancellationRegistry.RequestCancel(prRef);
        var discardHandle = await lockRegistry.TryAcquireAsync(prRef, DiscardTimeouts.LockAcquireTimeout, ct).ConfigureAwait(false);
        if (discardHandle is null)
            return Results.Json(new SubmitErrorDto("pipeline-cancellation-timeout",
                "The in-flight submit pipeline did not release within the allowed window. Try again."),
                statusCode: StatusCodes.Status504GatewayTimeout);

        string? pendingToDelete = null;
        try
        {
            await stateStore.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing)) return state;
                pendingToDelete = existing.PendingReviewId;
                var cleared = existing with
                {
                    DraftComments = Array.Empty<DraftComment>(),
                    DraftReplies = Array.Empty<DraftReply>(),
                    DraftVerdict = null,
                    DraftVerdictStatus = DraftVerdictStatus.Draft,
                    PendingReviewId = null,
                    PendingReviewCommitOid = null,
                };
                return state.WithSession(sessionKey, cleared);
            }, ct).ConfigureAwait(false);
        }
        finally
        {
            await discardHandle.DisposeAsync().ConfigureAwait(false);
        }

        bus.Publish(new StateChanged(prRef, DiscardedFields, SourceTabId: null));

        // Courtesy delete — best-effort, fire-and-forget (spec § 13.2 step 3: logged, not awaited as
        // a blocker). The local clear has already succeeded; the remote call must not delay or be
        // cancelled with the HTTP response, so it runs on a Task.Run with the host's ApplicationStopping
        // token (not the request ct). On failure: log (pendingReviewId scrubbed, exception attached)
        // and publish submit-orphan-cleanup-failed so the frontend toasts.
        if (!string.IsNullOrEmpty(pendingToDelete))
        {
            var toDelete = pendingToDelete;
            var hostCt = appLifetime.ApplicationStopping;
            _ = Task.Run(async () =>
            {
                try
                {
                    await submitter.DeletePendingReviewAsync(prRef, toDelete, hostCt).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (hostCt.IsCancellationRequested)
                {
                    // Host shutting down — the local clear already persisted; the orphan (if any) is
                    // cleaned up on the next successful submit on this PR.
                }
#pragma warning disable CA1031 // courtesy cleanup is best-effort by design — a failure is reported, not fatal
                catch (Exception ex)
                {
                    // Pass the blocked field name explicitly (not nameof(local)) so the scrubber redacts it.
                    s_courtesyDeleteFailed(
                        loggerFactory.CreateLogger("PRism.Web.Endpoints.PrDraftsDiscardAllEndpoint"),
                        sessionKey,
                        SensitiveFieldScrubber.Scrub("pendingReviewId", toDelete),
                        ex.Message,
                        ex);
                    bus.Publish(new SubmitOrphanCleanupFailedBusEvent(prRef));
                }
#pragma warning restore CA1031
            }, CancellationToken.None);
        }

        return Results.Ok();
    }
}
