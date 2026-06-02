using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

// T10 — POST /api/pr/{ref}/root-comment/post
//
// Posts the PR-root draft comment (FilePath null, LineNumber null) as a standalone GitHub
// issue comment via IReviewSubmitter.CreateIssueCommentAsync, WITHOUT submitting a review.
// On success: stamps PostedCommentId + PostedBodySnapshot, then deletes the local draft,
// then publishes StateChanged + RootCommentPostedBusEvent.
//
// The endpoint shares the per-PR SubmitLockRegistry slot with /submit — Post and Submit
// cannot run concurrently (both return 409 "submit-in-progress" on contention). The lock is
// acquired non-blocking (TimeSpan.Zero) and released in a finally block.
//
// Edge cases:
//   - Already-posted, same body → idempotent: delete draft, publish StateChanged, return 204
//     (no GitHub call — the comment already exists on github.com).
//   - Already-posted, different body → 409 PostMismatchErrorDto: user edited the draft after
//     the first post and the local draft is now out of sync with github.com. The frontend can
//     offer "Edit on github.com" (via the postedCommentId) or "Discard local draft".
//   - Body > GitHubReviewBodyMaxChars → 400 "body-too-large" (defensive; the body-size
//     middleware is wired in T13, but the per-endpoint check prevents a mis-configured cap
//     from reaching the GitHub API).
internal static class PrRootCommentEndpoints
{
    private static readonly string[] FieldsTouched = { "draft-comments" };

    private static readonly Action<ILogger, string, Exception?> s_rootCommentFailed =
        LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0, "RootCommentPostFailed"),
            "POST /root-comment/post failed with a GitHub network error for {SessionKey}");

    public static IEndpointRouteBuilder MapPrRootCommentEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/root-comment/post", PostRootCommentAsync);
        return app;
    }

    private static async Task<IResult> PostRootCommentAsync(
        string owner, string repo, int number,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        SubmitLockRegistry lockRegistry,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();

        // --- Authorization (same broader-than-spec authz as /submit; spec T10 § 6.2) ---
        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before posting a comment."),
                statusCode: StatusCodes.Status401Unauthorized);

        // --- Per-PR lock (TimeSpan.Zero → non-blocking; 409 on contention) ---
        // The lock is acquired synchronously; PostRootCommentAsync itself is the sole owner
        // (unlike /submit which transfers ownership to a fire-and-forget Task.Run). We use
        // `await using` here because Post is fully synchronous from lock to release.
#pragma warning disable CA2000  // SubmitLockHandle is always disposed in the finally below
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct).ConfigureAwait(false);
#pragma warning restore CA2000
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit or post is already in flight for this PR."),
                statusCode: StatusCodes.Status409Conflict);

        try
        {
            return await PostRootCommentCoreAsync(prRef, sessionKey, stateStore, submitter, bus, loggerFactory, ct)
                .ConfigureAwait(false);
        }
        finally
        {
            await handle.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static async Task<IResult> PostRootCommentCoreAsync(
        PrReference prRef,
        string sessionKey,
        IAppStateStore stateStore,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var appState = await stateStore.LoadAsync(ct).ConfigureAwait(false);
        if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session))
            return Results.Json(new SubmitErrorDto("no-session", "No draft session for this PR."),
                statusCode: StatusCodes.Status400BadRequest);

        // Find the PR-root draft (FilePath null AND LineNumber null).
        var rootDraft = session.DraftComments.FirstOrDefault(d => d.FilePath is null && d.LineNumber is null);
        if (rootDraft is null)
            return Results.Json(new SubmitErrorDto("no-root-draft", "No PR-root draft exists for this PR."),
                statusCode: StatusCodes.Status400BadRequest);

        // --- Already-posted branch ---
        if (rootDraft.PostedCommentId is { } existingId)
        {
            if (!string.Equals(rootDraft.PostedBodySnapshot, rootDraft.BodyMarkdown, StringComparison.Ordinal))
            {
                // Body was edited after the first post — the local draft is now out of sync.
                return Results.Json(new PostMismatchErrorDto(
                    "posted-body-mismatch",
                    "The draft body was edited after it was first posted. Discard the local draft or edit the comment on github.com.",
                    existingId),
                    statusCode: StatusCodes.Status409Conflict);
            }

            // Idempotent re-post of identical body: no GitHub call — delete draft + publish.
            await DeleteDraftAsync(stateStore, sessionKey, rootDraft.Id, ct).ConfigureAwait(false);
            bus.Publish(new StateChanged(prRef, FieldsTouched, SourceTabId: null));
            return Results.NoContent();
        }

        // --- Defensive body-cap ---
        if (rootDraft.BodyMarkdown.Length > PipelineMarker.GitHubReviewBodyMaxChars)
            return Results.Json(new SubmitErrorDto("body-too-large",
                $"The PR-root comment body exceeds the GitHub limit of {PipelineMarker.GitHubReviewBodyMaxChars} characters."),
                statusCode: StatusCodes.Status400BadRequest);

        // --- Call GitHub ---
        CreatedIssueCommentResult created;
        try
        {
            created = await submitter.CreateIssueCommentAsync(prRef, rootDraft.BodyMarkdown, ct)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (HttpRequestException hre)
        {
            s_rootCommentFailed(loggerFactory.CreateLogger(typeof(PrRootCommentEndpoints).FullName!), sessionKey, hre);
            return Results.Json(MapGithubError(hre), statusCode: StatusCodes.Status502BadGateway);
        }
#pragma warning disable CA1031  // catch-all so a rare GitHub SDK exception (non-HTTP) still surfaces a 502 instead of a bare 500
        catch (Exception ex)
        {
            s_rootCommentFailed(loggerFactory.CreateLogger(typeof(PrRootCommentEndpoints).FullName!), sessionKey, ex);
            return Results.Json(new SubmitErrorDto("github-network-error", "Failed to post the comment to GitHub."),
                statusCode: StatusCodes.Status502BadGateway);
        }
#pragma warning restore CA1031

        // --- Stamp PostedCommentId + PostedBodySnapshot (overlay #1), then delete draft (overlay #2) ---
        // The two-step order is crash-retry safe: if the process crashes between stamp and delete, the
        // next POST sees PostedCommentId set + PostedBodySnapshot == BodyMarkdown → idempotent branch
        // (no new GitHub call, just deletes the draft). If the process crashes before stamp, the next
        // POST re-calls CreateIssueCommentAsync, creating a second comment — acceptable for this PoC.
        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return state;
            var updatedComments = s.DraftComments
                .Select(d => d.Id == rootDraft.Id
                    ? d with { PostedCommentId = created.Id, PostedBodySnapshot = rootDraft.BodyMarkdown }
                    : d)
                .ToList();
            return WithSession(state, sessionKey, s with { DraftComments = updatedComments });
        }, ct).ConfigureAwait(false);

        await DeleteDraftAsync(stateStore, sessionKey, rootDraft.Id, ct).ConfigureAwait(false);

        // --- Publish bus events ---
        bus.Publish(new StateChanged(prRef, FieldsTouched, SourceTabId: null));
        // SSE projection wired in Task 14
        bus.Publish(new RootCommentPostedBusEvent(prRef, created.Id));

        return Results.NoContent();
    }

    // ------------------------------------------------------------------ helpers

    private static async Task DeleteDraftAsync(
        IAppStateStore stateStore, string sessionKey, string draftId, CancellationToken ct)
    {
        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return state;
            var remaining = s.DraftComments.Where(d => d.Id != draftId).ToList();
            return WithSession(state, sessionKey, s with { DraftComments = remaining });
        }, ct).ConfigureAwait(false);
    }

    private static AppState WithSession(AppState state, string sessionKey, ReviewSessionState session)
    {
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = session };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }

    private static SubmitErrorDto MapGithubError(HttpRequestException hre)
    {
        var status = hre.StatusCode;
        var code = status switch
        {
            System.Net.HttpStatusCode.Forbidden => "github-forbidden",
            System.Net.HttpStatusCode.Unauthorized => "github-unauthorized",
            System.Net.HttpStatusCode.UnprocessableEntity => "github-validation-error",
            _ => "github-network-error",
        };
        return new SubmitErrorDto(code, hre.Message);
    }
}
