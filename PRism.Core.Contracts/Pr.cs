using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
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
    DateTimeOffset OpenedAt,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
