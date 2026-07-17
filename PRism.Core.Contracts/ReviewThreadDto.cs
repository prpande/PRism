using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int? LineNumber,          // null = outdated or file-level (no 0 sentinel)
    bool IsOutdated,
    int? OriginalLine,
    int? OriginalStartLine,   // multi-line ranges; null for single-line
    string SubjectType,       // "LINE" | "FILE"
    string? DiffHunk,         // first comment's hunk; null if unavailable
    long? ReviewDatabaseId,   // first comment's parent review; timeline join key
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
