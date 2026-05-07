namespace PRism.Core.Contracts;

public sealed record IssueCommentDto(
    long Id,
    string Author,
    DateTimeOffset CreatedAt,
    string Body);
