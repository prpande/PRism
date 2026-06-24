using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Serialization;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommitCount,
    int ChangedFiles,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    CiStatus Ci,
    string? LastViewedHeadSha,
    long? LastSeenCommentId,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null,
    bool IsDraft = false,
    [property: JsonIgnore] string? Description = null,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    // #593 reviewer name-lists for the readiness popover (parallel to Pr). Null = not fetched.
    IReadOnlyList<Reviewer>? Approvers = null,
    IReadOnlyList<Reviewer>? ChangesRequestedBy = null,
    IReadOnlyList<Reviewer>? AwaitingReviewers = null);
