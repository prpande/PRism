namespace PRism.Core.Contracts;

public sealed record DraftReview(
    PrReference Pr,
    Verdict Verdict,
    string SummaryMarkdown,
    IReadOnlyList<DraftCommentInput> NewThreads,
    IReadOnlyList<DraftReplyInput> Replies,
    string? PendingReviewId,
    string? CommitOid);
