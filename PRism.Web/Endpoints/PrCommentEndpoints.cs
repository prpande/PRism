using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

// #302 — POST /api/pr/{ref}/comment/post. Posts a single inline comment or reply directly (no review).
// Discriminates by draft KIND. Mirrors PrRootCommentEndpoints: IsSubscribed authz, per-PR lock,
// stamp-then-delete idempotency, sanitized errors, body-cap. Returns 200 { postedCommentId } so the
// frontend can de-dup the optimistic placeholder against the refetched comment.
internal static class PrCommentEndpoints
{
    private static readonly string[] FieldsTouched = { "draft-comments", "draft-replies" };
    private static readonly string LoggerCategory = typeof(PrCommentEndpoints).FullName!;
    private static readonly Action<ILogger, string, Exception?> s_commentPostFailed =
        LoggerMessage.Define<string>(LogLevel.Warning, new EventId(1, "CommentPostFailed"),
            "POST /comment/post failed with a GitHub error for {SessionKey}");

    internal sealed record PostCommentPayload(string DraftId);
    internal sealed record PostCommentOkDto(long PostedCommentId);

    public static IEndpointRouteBuilder MapPrCommentEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/comment/post", PostCommentAsync);
        return app;
    }

    private static async Task<IResult> PostCommentAsync(
        string owner, string repo, int number, PostCommentPayload payload,
        IAppStateStore stateStore, IActivePrCache activePrCache, IReviewSubmitter submitter,
        IReviewEventBus bus, SubmitLockRegistry lockRegistry, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(payload);
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();

        if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before posting a comment.") is { } notSubscribed)
            return notSubscribed;

#pragma warning disable CA2000
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct).ConfigureAwait(false);
#pragma warning restore CA2000
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit or post is already in flight for this PR."),
                statusCode: StatusCodes.Status409Conflict);
        try
        {
            var appState = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session)) return NoDraft();

            // Discriminate by draft KIND, scoped to THIS session (Security-3).
            var inline = session.DraftComments.FirstOrDefault(d => d.Id == payload.DraftId);
            if (inline is { }) return await PostInlineAsync(prRef, sessionKey, inline, stateStore, submitter, bus, loggerFactory, ct).ConfigureAwait(false);
            var reply = session.DraftReplies.FirstOrDefault(r => r.Id == payload.DraftId);
            if (reply is { }) return await PostReplyAsync(prRef, sessionKey, reply, stateStore, submitter, bus, loggerFactory, ct).ConfigureAwait(false);
            return NoDraft();
        }
        finally { await handle.DisposeAsync().ConfigureAwait(false); }
    }

    private static async Task<IResult> PostInlineAsync(
        PrReference prRef, string sessionKey, DraftComment draft, IAppStateStore store,
        IReviewSubmitter submitter, IReviewEventBus bus, ILoggerFactory lf, CancellationToken ct)
    {
        // #324 — this is an *attachability* guard, NOT the PR-root predicate: an inline post target
        // must be fully anchored (both file and line). It is intentionally NOT `!IsPrRoot`
        // (= FilePath is not null), which would wrongly accept a headless `(file, null)` comment.
        if (draft.FilePath is null || draft.LineNumber is null) return NoDraft();
        if (draft.PostedCommentId is { } posted)
            return await AlreadyPostedAsync(store, sessionKey, draft.Id, draft.BodyMarkdown, draft.PostedBodySnapshot, posted, prRef, bus, isReply: false, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(draft.AnchoredSha))
            return Results.Json(new SubmitErrorDto("missing-anchor", "This draft has no commit anchor; reopen the composer and try again."), statusCode: StatusCodes.Status400BadRequest);

        // #605 item B — re-read the draft body from the store inside the submit lock, immediately
        // before the GitHub call. The body captured by the caller's pre-lock LoadAsync can be made
        // stale by a concurrent PUT /draft (the draft writer participates only in the store's _gate,
        // not this submit lock) that landed between that load and here; posting the stale snapshot
        // would silently lose the edit and then StampThenDelete would drop the draft for good. Other
        // fields (anchor / file / line) are immutable for a draft, so only the body is re-read.
        var freshBody = await ReloadCommentBodyAsync(store, sessionKey, draft.Id, ct).ConfigureAwait(false);
        if (freshBody is null) return NoDraft();
        if (freshBody.Length > PipelineMarker.GitHubReviewBodyMaxChars) return BodyTooLarge();

        var request = new ReviewCommentRequest(draft.AnchoredSha, draft.FilePath, draft.LineNumber.Value,
            (draft.Side ?? "right").ToUpperInvariant(), freshBody);
        CreatedReviewCommentResult created;
        try { created = await submitter.CreateReviewCommentAsync(prRef, request, ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw; }
        catch (HttpRequestException hre) { s_commentPostFailed(lf.CreateLogger(LoggerCategory), sessionKey, hre); return GitHubErrorMapper.ToResult(hre); }
#pragma warning disable CA1031
        catch (Exception ex) { s_commentPostFailed(lf.CreateLogger(LoggerCategory), sessionKey, ex); return GitHubErrorMapper.ToResult(ex); }
#pragma warning restore CA1031

        await StampThenDeleteComment(store, sessionKey, draft.Id, created.Id, freshBody, ct).ConfigureAwait(false);
        Publish(bus, prRef, created.Id);
        return Results.Json(new PostCommentOkDto(created.Id));
    }

    private static async Task<IResult> PostReplyAsync(
        PrReference prRef, string sessionKey, DraftReply draft, IAppStateStore store,
        IReviewSubmitter submitter, IReviewEventBus bus, ILoggerFactory lf, CancellationToken ct)
    {
        if (draft.PostedCommentId is { } posted)
            return await AlreadyPostedAsync(store, sessionKey, draft.Id, draft.BodyMarkdown, draft.PostedBodySnapshot, posted, prRef, bus, isReply: true, ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(draft.ParentThreadId))
            return Results.Json(new SubmitErrorDto("missing-thread", "This reply draft has no parent thread; reload the page and try again."), statusCode: StatusCodes.Status400BadRequest);

        // #605 item B — re-read the reply body inside the submit lock immediately before the GitHub
        // call (see PostInlineAsync for the race rationale).
        var freshBody = await ReloadReplyBodyAsync(store, sessionKey, draft.Id, ct).ConfigureAwait(false);
        if (freshBody is null) return NoDraft();
        if (freshBody.Length > PipelineMarker.GitHubReviewBodyMaxChars) return BodyTooLarge();

        CreatedReviewCommentResult created;
        try { created = await submitter.CreateReviewCommentReplyAsync(prRef, draft.ParentThreadId, freshBody, ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw; }
        catch (HttpRequestException hre) { s_commentPostFailed(lf.CreateLogger(LoggerCategory), sessionKey, hre); return GitHubErrorMapper.ToResult(hre); }
#pragma warning disable CA1031
        catch (Exception ex) { s_commentPostFailed(lf.CreateLogger(LoggerCategory), sessionKey, ex); return GitHubErrorMapper.ToResult(ex); }
#pragma warning restore CA1031

        await StampThenDeleteReply(store, sessionKey, draft.Id, created.Id, freshBody, ct).ConfigureAwait(false);
        Publish(bus, prRef, created.Id);
        return Results.Json(new PostCommentOkDto(created.Id));
    }

    // #605 item B — re-read the current persisted body for a draft (by id, scoped to the session)
    // so the posting path sends the latest text rather than a pre-lock snapshot. Returns null when
    // the draft no longer exists (a concurrent delete) → the caller surfaces no-draft.
    private static async Task<string?> ReloadCommentBodyAsync(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct)
    {
        var state = await store.LoadAsync(ct).ConfigureAwait(false);
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return null;
        return s.DraftComments.FirstOrDefault(d => d.Id == draftId)?.BodyMarkdown;
    }

    private static async Task<string?> ReloadReplyBodyAsync(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct)
    {
        var state = await store.LoadAsync(ct).ConfigureAwait(false);
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return null;
        return s.DraftReplies.FirstOrDefault(r => r.Id == draftId)?.BodyMarkdown;
    }

    private static void Publish(IReviewEventBus bus, PrReference prRef, long id)
    {
        bus.Publish(new StateChanged(prRef, FieldsTouched, SourceTabId: null));
        bus.Publish(new SingleCommentPostedBusEvent(prRef, id));
    }

    private static IResult NoDraft() => Results.Json(new SubmitErrorDto("no-draft", "No matching draft for this PR."), statusCode: StatusCodes.Status400BadRequest);
    private static IResult BodyTooLarge() => Results.Json(new SubmitErrorDto("body-too-large", $"The comment body exceeds the GitHub limit of {PipelineMarker.GitHubReviewBodyMaxChars} characters."), statusCode: StatusCodes.Status400BadRequest);

    private static async Task<IResult> AlreadyPostedAsync(IAppStateStore store, string sessionKey, string draftId,
        string body, string? snapshot, long postedId, PrReference prRef, IReviewEventBus bus, bool isReply, CancellationToken ct)
    {
        if (!string.Equals(snapshot, body, StringComparison.Ordinal))
            return Results.Json(new PostMismatchErrorDto("already-posted-body-mismatch",
                "The draft body was edited after it was first posted. Discard the local draft or edit the comment on github.com.", postedId),
                statusCode: StatusCodes.Status409Conflict);
        if (isReply) await DeleteReply(store, sessionKey, draftId, ct).ConfigureAwait(false);
        else await DeleteComment(store, sessionKey, draftId, ct).ConfigureAwait(false);
        // Idempotent re-post path: the comment already exists on GitHub and was already surfaced
        // on its first post, so deliberately NO SingleCommentPostedBusEvent here (#450) — there is
        // no fresh thread to evict-and-reload for. The 200 returns postedId for optimistic de-dup.
        bus.Publish(new StateChanged(prRef, FieldsTouched, SourceTabId: null));
        // 200 (not 204 like the root-comment precedent): the frontend needs postedCommentId to de-dup the optimistic placeholder.
        return Results.Json(new PostCommentOkDto(postedId));
    }

    private static Task StampThenDeleteComment(IAppStateStore store, string sessionKey, string draftId, long postedId, string body, CancellationToken ct) =>
        TwoStep(store, sessionKey,
            s => s with { DraftComments = s.DraftComments.Select(d => d.Id == draftId ? d with { PostedCommentId = postedId, PostedBodySnapshot = body } : d).ToList() },
            s => s with { DraftComments = s.DraftComments.Where(d => d.Id != draftId).ToList() },
            ct);
    private static Task StampThenDeleteReply(IAppStateStore store, string sessionKey, string draftId, long postedId, string body, CancellationToken ct) =>
        TwoStep(store, sessionKey,
            s => s with { DraftReplies = s.DraftReplies.Select(r => r.Id == draftId ? r with { PostedCommentId = postedId, PostedBodySnapshot = body } : r).ToList() },
            s => s with { DraftReplies = s.DraftReplies.Where(r => r.Id != draftId).ToList() },
            ct);

    private static async Task TwoStep(IAppStateStore store, string sessionKey,
        Func<ReviewSessionState, ReviewSessionState> stamp, Func<ReviewSessionState, ReviewSessionState> delete,
        CancellationToken ct)
    {
        await store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? state.WithSession(sessionKey, stamp(s)) : state, ct).ConfigureAwait(false);
        await store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? state.WithSession(sessionKey, delete(s)) : state, ct).ConfigureAwait(false);
    }
    private static Task DeleteComment(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct) =>
        store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? state.WithSession(sessionKey, s with { DraftComments = s.DraftComments.Where(d => d.Id != draftId).ToList() }) : state, ct);
    private static Task DeleteReply(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct) =>
        store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? state.WithSession(sessionKey, s with { DraftReplies = s.DraftReplies.Where(r => r.Id != draftId).ToList() }) : state, ct);

}
