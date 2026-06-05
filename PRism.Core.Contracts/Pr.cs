using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl and HtmlUrl are raw URL strings from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl and HtmlUrl are raw URL strings from the GitHub API.")]
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
    string? AvatarUrl = null,
    string? HtmlUrl = null);
