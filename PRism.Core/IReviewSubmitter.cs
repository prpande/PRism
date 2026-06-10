using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Core;

// Capability sub-interface from the ADR-S5-1 split of IReviewService.
// The seven methods drive the GraphQL pending-review pipeline; SubmitPipeline (PR2) is the
// state machine on top of them. See docs/specs/2026-05-11-s5-submit-pipeline-design.md § 3 + § 4.
public interface IReviewSubmitter
{
    // Step 1 — create a pending review (no event → stays PENDING). summaryBody is sent verbatim,
    // including the empty string; never omitted.
    Task<BeginPendingReviewResult> BeginPendingReviewAsync(
        PrReference reference,
        string commitOid,
        string summaryBody,
        CancellationToken ct);

    // Step 2 — attach a single new thread to the pending review.
    Task<AttachThreadResult> AttachThreadAsync(
        PrReference reference,
        string pendingReviewId,
        DraftThreadRequest draft,
        CancellationToken ct);

    // Step 3 — attach a single reply to an existing thread on the pending review.
    Task<AttachReplyResult> AttachReplyAsync(
        PrReference reference,
        string pendingReviewId,
        string parentThreadId,
        string replyBody,
        CancellationToken ct);

    // Step 4 — finalize: submit the pending review with a verdict event.
    Task FinalizePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        SubmitEvent verdict,
        CancellationToken ct);

    // Discard path — delete the whole pending review (used by the stale-commitOID recreate branch
    // and by the closed/merged bulk-discard courtesy cleanup).
    Task DeletePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        CancellationToken ct);

    // Best-effort cleanup of a single duplicate thread under the multi-marker-match defense
    // (§ 5.2 step 3): when more than one server thread carries the same draft's marker, the
    // pipeline adopts the earliest and asks to delete the rest.
    Task DeletePendingReviewThreadAsync(
        PrReference reference,
        string pullRequestReviewThreadId,
        CancellationToken ct);

    // Detection — returns the viewer's pending review on this PR (if any), with attached threads +
    // per-thread reply chains. Drives the foreign-pending-review prompt and lost-response adoption.
    Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(
        PrReference reference,
        CancellationToken ct);

    // Post a standalone issue comment to the PR conversation (REST POST /repos/{o}/{r}/issues/{n}/comments).
    // Unlike the pending-review pipeline methods, this publishes immediately and is visible to all
    // participants the moment it returns. Used by POST /api/pr/.../root-comment/post (Task 10) to
    // "Post" a PR-root draft without going through the GraphQL pending-review flow.
    Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
        PrReference reference,
        string bodyMarkdown,
        CancellationToken ct);

    // #302 — post a single NEW inline review comment directly (REST POST /pulls/{n}/comments),
    // bypassing the pending-review pipeline. Publishes immediately.
    Task<CreatedReviewCommentResult> CreateReviewCommentAsync(
        PrReference reference, ReviewCommentRequest request, CancellationToken ct);

    // #302 — post a single reply to an existing review thread directly, via GraphQL
    // addPullRequestReviewThreadReply WITHOUT a pullRequestReviewId (omitting it posts immediately —
    // see GitHubReviewService.Submit.cs:115-116). Uses the draft's own ParentThreadId.
    Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(
        PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct);
}
