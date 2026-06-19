namespace PRism.Core.Contracts;

// The viewer's latest effective submitted review on a PR. Null on PrDetailDto = the viewer
// has no effective review. CommitSha is nullable: a review may carry no commit association,
// in which case staleness is unknown (the frontend shows no stale flag).
public sealed record ViewerReview(ReviewState State, DateTimeOffset SubmittedAt, string? CommitSha);
