using PRism.Core.Contracts;

namespace PRism.Core.Events;

// Published by ActivePrPoller when a per-PR poll detects a head-SHA change or comment-count
// change. SseChannel subscribes and fans out to per-PR subscribers as `event: pr-updated`.
// CommentCountDelta is the signed change since the previous poll (0 on first poll) — the
// frontend BannerRefresh accumulates it; see SseEventProjection.ActivePrUpdatedWire.
public sealed record ActivePrUpdated(
    PrReference PrRef,
    bool HeadShaChanged,
    bool CommentCountChanged,
    string? NewHeadSha,
    int CommentCountDelta) : IReviewEvent;
