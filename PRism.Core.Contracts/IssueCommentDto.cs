using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is deserialized from the GitHub REST API as a raw string.")]
public sealed record IssueCommentDto(
    long Id,
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    string? AvatarUrl = null);
