namespace PRism.Core.Contracts;

public sealed record IterationDto(
    int Number,
    string BeforeSha,
    string AfterSha,
    IReadOnlyList<CommitDto> Commits,
    bool HasResolvableRange);

public sealed record CommitDto(
    string Sha,
    string Message,
    DateTimeOffset CommittedDate,
    int Additions,
    int Deletions);
