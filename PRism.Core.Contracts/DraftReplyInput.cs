namespace PRism.Core.Contracts;

public sealed record DraftReplyInput(
    string Id,
    string ParentThreadId,
    string BodyMarkdown,
    string? ReplyCommentId);
