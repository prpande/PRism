using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int LineNumber,
    string AnchorSha,
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
public sealed record ReviewCommentDto(
    string CommentId,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    DateTimeOffset? EditedAt,
    string? AvatarUrl = null);
