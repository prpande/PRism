namespace PRism.Core.PrDetail;

// Per-PR poller state. Mutated only inside ActivePrPoller's per-PR loop body, which is
// single-threaded per Tick — no internal synchronization needed.
internal sealed class ActivePrPollerState
{
    public string? LastHeadSha { get; set; }
    public int? LastCommentCount { get; set; }
    public int ConsecutiveErrors { get; set; }
    public DateTimeOffset? NextRetryAt { get; set; }
}
