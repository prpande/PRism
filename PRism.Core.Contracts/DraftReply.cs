namespace PRism.Core.Contracts;

public sealed record DraftReply(
    string Id,
    string ParentThreadId,
    string BodyMarkdown,
    string? ReplyCommentId);
