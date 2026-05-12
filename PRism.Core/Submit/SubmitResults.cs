namespace PRism.Core.Submit;

// Result / snapshot records returned by IReviewSubmitter. See spec § 4.

// Returned by BeginPendingReviewAsync — the GraphQL node ID of the freshly created pending review.
public sealed record BeginPendingReviewResult(string PullRequestReviewId);

// Returned by AttachThreadAsync — the GraphQL node ID of the created thread; SubmitPipeline stamps
// this into DraftComment.ThreadId so a later retry skips re-attaching.
public sealed record AttachThreadResult(string PullRequestReviewThreadId);

// Returned by AttachReplyAsync — the GraphQL node ID of the created reply comment.
public sealed record AttachReplyResult(string CommentId);

// Returned by FindOwnPendingReviewAsync — the viewer's current pending review on a PR (if any),
// with its attached threads + per-thread reply chains. Drives the foreign-pending-review prompt
// (§ 5.2 step 1) and the lost-response marker-adoption step (§ 5.2 step 3).
public sealed record OwnPendingReviewSnapshot(
    string PullRequestReviewId,
    string CommitOid,
    DateTimeOffset CreatedAt,   // GraphQL PullRequestReview.createdAt — DateTimeOffset to match the adapter's other GitHub timestamps
    IReadOnlyList<PendingReviewThreadSnapshot> Threads);

public sealed record PendingReviewThreadSnapshot(
    string PullRequestReviewThreadId,
    string FilePath,
    int LineNumber,
    string Side,                // GraphQL diffSide; needed to reconstruct DraftComment on Resume
    string OriginalCommitOid,   // GraphQL originalCommit.oid; populates DraftComment.AnchoredSha on Resume
    string OriginalLineContent, // populates DraftComment.AnchoredLineContent on Resume; the GitHub adapter
                                // leaves this empty — PR5's Resume endpoint enriches it from the file
                                // content at originalCommit (an empty value poisons reconciliation, so it
                                // MUST be enriched before any imported draft is reconciled).
    bool IsResolved,            // GraphQL PullRequestReviewThread.isResolved; surfaces a "Resolved on github.com" badge on Resume
    string BodyMarkdown,        // raw thread body returned by GraphQL (marker preserved per C7)
    IReadOnlyList<PendingReviewCommentSnapshot> Comments);  // replies only — the thread body is BodyMarkdown, not Comments[0]

public sealed record PendingReviewCommentSnapshot(
    string CommentId,
    string BodyMarkdown);
