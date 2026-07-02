using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

// Per-PR poller state. Mutated only inside ActivePrPoller's per-PR loop body, which is
// single-threaded per Tick — no internal synchronization needed.
internal sealed class ActivePrPollerState
{
    public string? LastHeadSha { get; set; }
    public string? LastBaseSha { get; set; }
    public int? LastCommentCount { get; set; }
    public PrState? LastPrState { get; set; }
    // Last-known non-None readiness. Retained across an aborted/skipped tick and across a
    // transient UNKNOWN->None so the live badge never blanks or churns (anti-flicker, #598 Slice B).
    public MergeReadiness? LastMergeReadiness { get; set; }
    public int ConsecutiveErrors { get; set; }
    public DateTimeOffset? NextRetryAt { get; set; }
    // #620: root-issue-comment + reviewer-delta gate terms. A new root PR comment (the feed's
    // primary content) or an approval/changes-request/review-request delta bumps neither
    // HeadSha, CommentCount (inline-review-thread only), PrState, nor MergeReadiness — these
    // retain the prior tick's values so the gate can detect the delta independently.
    public int? LastIssueCommentCount { get; set; }
    public int? LastApprovals { get; set; }
    public int? LastChangesRequested { get; set; }
    public int? LastAwaitingCount { get; set; }
    // Number of fast-retry attempts issued for the current (ref, headSha) burst. Incremented
    // each time wantsFastRetry is true; reset to 0 on a new HeadSha or a resolved readiness.
    // Capped at FastRetryCap (5) so the poller reverts to the normal cadence after the burst.
    public int FastRetryCount { get; set; }
}
