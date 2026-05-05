namespace PRism.Core.Contracts;

public sealed record DraftReview(
    PrReference Pr,
    Verdict Verdict,
    string SummaryMarkdown,
    IReadOnlyList<DraftComment> NewThreads,
    IReadOnlyList<DraftReply> Replies,
    string? PendingReviewId,
    string? CommitOid);
