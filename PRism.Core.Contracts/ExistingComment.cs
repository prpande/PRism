namespace PRism.Core.Contracts;

public sealed record ExistingComment(
    string Id,
    string Author,
    string Body,
    string Path,
    int? Line,
    string? ThreadId,
    string? ParentId);
