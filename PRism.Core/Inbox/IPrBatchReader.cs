using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

/// <summary>
/// One aliased-batch GraphQL read of hydration fields + the viewer's last-review SHA for
/// every inbox PR, replacing the per-PR REST hydration and awaiting-author review walk.
/// Caches per (Reference, UpdatedAt); returns only refs that resolved — unresolved refs
/// (PAT can't see the repo, deleted PR, malformed alias) are simply absent. Throws
/// <see cref="RateLimitExceededException"/> on a GitHub rate limit; any other transport
/// failure propagates and aborts the refresh tick.
/// </summary>
public interface IPrBatchReader
{
    Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct);
}

/// <summary>Hydration fields from the GraphQL pullRequest node, plus the viewer's
/// last-review head SHA (computed at parse time from <c>reviews(last:100)</c>),
/// and merge-readiness signals derived from the collapsed <c>latestReviews</c> connection.</summary>
public sealed record BatchPrData(
    string HeadSha,
    int Additions,
    int Deletions,
    int CommitCount,
    int ChangedFiles,
    DateTimeOffset PushedAt,
    DateTimeOffset? MergedAt,
    DateTimeOffset? ClosedAt,
    string? ViewerLastReviewSha,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    // #593 reviewer name-lists parsed from latestReviews (approvers/changes) + reviewRequests (waiting).
    IReadOnlyList<Reviewer>? Approvers = null,
    IReadOnlyList<Reviewer>? ChangesRequestedBy = null,
    IReadOnlyList<Reviewer>? AwaitingReviewers = null);
