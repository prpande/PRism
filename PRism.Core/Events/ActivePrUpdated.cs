using PRism.Core.Contracts;

namespace PRism.Core.Events;

// Published by ActivePrPoller when a per-PR poll detects a head-SHA change or comment-count
// change. SseChannel subscribes and fans out to per-PR subscribers as `event: pr-updated`.
// CommentCountDelta is the signed change since the previous poll (0 on first poll) — the
// frontend BannerRefresh accumulates it; see SseEventProjection.ActivePrUpdatedWire.
// IsMerged / IsClosed carry the PR close-state on an open→done transition so the frontend can
// render a live "This PR was just merged/closed" banner. They are mutually exclusive: a merged
// PR is flagged IsMerged only (not also IsClosed). Trailing-with-defaults so construction sites
// that predate the close-state thread still compile. Spec § 5.2.3.
// MergeReadiness + counts carry the live merge-readiness badge through the SSE channel (#598
// Slice B). MergeReadinessChanged gates the live badge refresh: it is true only on a change TO a
// real (non-None) readiness — a transient None (GitHub's async mergeStateStatus recompute) must
// not churn the badge. Approvals/ChangesRequested are the collapsed latestReviews counts.
public sealed record ActivePrUpdated(
    PrReference PrRef,
    bool HeadShaChanged,
    bool CommentCountChanged,
    string? NewHeadSha,
    int CommentCountDelta,
    bool IsMerged = false,
    bool IsClosed = false,
    bool BaseShaChanged = false,
    string? NewBaseSha = null,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    bool MergeReadinessChanged = false,
    int? Approvals = null,
    int? ChangesRequested = null) : IReviewEvent;
