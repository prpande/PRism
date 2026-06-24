using System.Diagnostics.CodeAnalysis;

using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl is a raw URL string from the GitHub API.")]
public sealed record RawPrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    int CommitCount,
    int ChangedFiles,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null,
    bool IsDraft = false,
    string? Description = null,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    // Routing hint for the batch reader (#593): recently-closed/merged PRs render no badge (D5),
    // so they take the light GraphQL selection (no mergeable/mergeStateStatus/reviews/latestReviews)
    // — those merge-state fields force per-PR server-side computation and are pure waste for terminal
    // PRs. Open candidates default to false → full readiness selection.
    bool IsClosedHistory = false,
    // #593 reviewer name-lists carried from the batch read onto the enriched raw item, then
    // copied into PrInboxItem by ToPrInboxItem (parallels Approvals/ChangesRequested).
    IReadOnlyList<Reviewer>? Approvers = null,
    IReadOnlyList<Reviewer>? ChangesRequestedBy = null,
    IReadOnlyList<Reviewer>? AwaitingReviewers = null);
