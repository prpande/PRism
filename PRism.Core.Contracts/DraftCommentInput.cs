namespace PRism.Core.Contracts;

public sealed record DraftCommentInput(
    string Id,
    string FilePath,
    int LineNumber,
    string Side,
    string AnchoredSha,
    string AnchoredLineContent,
    string BodyMarkdown,
    string? ThreadId);
