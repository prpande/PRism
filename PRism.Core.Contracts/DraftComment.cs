namespace PRism.Core.Contracts;

public sealed record DraftComment(
    string Id,
    string FilePath,
    int LineNumber,
    string Side,
    string AnchoredSha,
    string AnchoredLineContent,
    string BodyMarkdown,
    string? ThreadId);
