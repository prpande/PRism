using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record IssueCommentDto(
    long Id,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    string? AvatarUrl = null);
