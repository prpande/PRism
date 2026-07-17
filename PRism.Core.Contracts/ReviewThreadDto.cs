using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int LineNumber,
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record ReviewCommentDto(
    string CommentId,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    DateTimeOffset? EditedAt,
    string? AvatarUrl = null,
    long? DatabaseId = null);   // #302 — REST numeric id, used to de-dup optimistic vs refetched comments
