using PRism.Core.Contracts;

namespace PRism.Core.Events;

// Published by ActivePrPoller when a per-PR poll detects a head-SHA change or comment-count
// change. SseChannel subscribes and fans out to per-PR subscribers as `event: pr-updated`.
public sealed record ActivePrUpdated(
    PrReference PrRef,
    bool HeadShaChanged,
    bool CommentCountChanged,
    string? NewHeadSha,
    int? NewCommentCount) : IReviewEvent;
