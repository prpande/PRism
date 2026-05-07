namespace PRism.Core.Contracts;

public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int LineNumber,
    string AnchorSha,
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);

public sealed record ReviewCommentDto(
    string CommentId,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    DateTimeOffset? EditedAt);
