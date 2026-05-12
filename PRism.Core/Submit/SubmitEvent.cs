namespace PRism.Core.Submit;

// The verdict event applied when a pending review is finalized (GraphQL submitPullRequestReview).
// Maps to GitHub's PullRequestReviewEvent enum: Approve → APPROVE, RequestChanges → REQUEST_CHANGES,
// Comment → COMMENT. (DISMISS / PENDING are not reachable from the Submit dialog.)
public enum SubmitEvent
{
    Approve,
    RequestChanges,
    Comment,
}
