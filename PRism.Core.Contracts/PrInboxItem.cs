using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int IterationNumber,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    CiStatus Ci,
    string? LastViewedHeadSha,
    long? LastSeenCommentId,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
