namespace PRism.Core.State;

/// <summary>
/// Pure overlay transforms over <see cref="AppState"/> that target a single named session
/// (<c>"&lt;owner&gt;/&lt;repo&gt;/&lt;number&gt;"</c>). These are designed to be passed to
/// <see cref="IAppStateStore.UpdateAsync"/> so the store re-reads the current state and applies
/// the overlay atomically — surviving foreign-tab writes that landed between snapshot-load and
/// commit. Extracted from <c>SubmitPipeline</c> in T4 so the submit-discard endpoint (T11) can
/// reuse the same clear semantics without taking a pipeline dependency.
/// </summary>
public static class SessionOverlays
{
    /// <summary>
    /// Clears the pending-review identity for <paramref name="sessionKey"/>: nulls
    /// <see cref="ReviewSessionState.PendingReviewId"/>, <see cref="ReviewSessionState.PendingReviewCommitOid"/>,
    /// every <see cref="DraftComment.ThreadId"/>, and every <see cref="DraftReply.ReplyCommentId"/>.
    /// Does NOT touch <see cref="DraftComment.PostedCommentId"/> or
    /// <see cref="DraftComment.PostedBodySnapshot"/> — those belong to the issue-comment lifecycle
    /// (PR-root post), not the review, and survive a discard. No-op when the session key is absent.
    /// </summary>
    public static AppState ClearPendingReviewStamps(AppState state, string sessionKey)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentException.ThrowIfNullOrEmpty(sessionKey);
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var cleared = cur with
        {
            PendingReviewId = null,
            PendingReviewCommitOid = null,
            DraftComments = cur.DraftComments.Select(d => d.ThreadId is null ? d : d with { ThreadId = null }).ToList(),
            DraftReplies = cur.DraftReplies.Select(r => r.ReplyCommentId is null ? r : r with { ReplyCommentId = null }).ToList(),
        };
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }
}
