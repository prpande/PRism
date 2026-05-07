namespace PRism.Core.Contracts;

public sealed record Pr(
    PrReference Reference,
    string Title,
    string Body,
    string Author,
    string State,
    string HeadSha,
    string BaseSha,
    string HeadBranch,
    string BaseBranch,
    string Mergeability,
    string CiSummary,
    bool IsMerged,
    bool IsClosed,
    DateTimeOffset OpenedAt);
