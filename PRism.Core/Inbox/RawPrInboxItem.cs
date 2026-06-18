using System.Diagnostics.CodeAnalysis;

using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record RawPrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    int IterationNumberApprox,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null,
    bool IsDraft = false,
    string? Description = null);
