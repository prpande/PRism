namespace PRism.Core.Iterations;

public sealed record ClusteringInput(
    IReadOnlyList<ClusteringCommit> Commits,
    IReadOnlyList<ClusteringForcePush> ForcePushes,
    IReadOnlyList<ClusteringReviewEvent> ReviewEvents,
    IReadOnlyList<ClusteringAuthorComment> AuthorPrComments);

public sealed record ClusteringCommit(
    string Sha,
    DateTimeOffset CommittedDate,
    string Message,
    int Additions,
    int Deletions,
    IReadOnlyList<string>? ChangedFiles);   // null = unknown (e.g., truncation, fan-out skipped)

public sealed record ClusteringForcePush(
    string? BeforeSha,
    string? AfterSha,
    DateTimeOffset OccurredAt);

public sealed record ClusteringReviewEvent(DateTimeOffset SubmittedAt);

public sealed record ClusteringAuthorComment(DateTimeOffset AuthoredAt);
