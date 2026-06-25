using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl and HtmlUrl are raw URL strings from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl and HtmlUrl are raw URL strings from the GitHub API.")]
public sealed record Pr(
    PrReference Reference,
    string Title,
    string Body,
    string Author,
    PrState State,
    string HeadSha,
    string BaseSha,
    string HeadBranch,
    string BaseBranch,
    string Mergeability,
    string CiSummary,
    bool IsMerged,
    bool IsClosed,
    DateTimeOffset OpenedAt,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null,
    string? HtmlUrl = null,
    bool IsDraft = false,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    DateTimeOffset UpdatedAt = default,
    // #593 reviewer name-lists for the readiness popover. Null = not fetched (FE suppresses the
    // row); the int counts above stay as a count-only fallback when avatars/names are unavailable.
    IReadOnlyList<Reviewer>? Approvers = null,
    IReadOnlyList<Reviewer>? ChangesRequestedBy = null,
    IReadOnlyList<Reviewer>? AwaitingReviewers = null);
