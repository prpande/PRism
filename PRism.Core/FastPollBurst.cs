namespace PRism.Core;

// Shared fast-retry burst schedule for a PR whose derived merge readiness is transiently None
// (GitHub is still computing mergeStateStatus on a freshly-opened/updated PR). The spec states
// this as ONE policy across both surfaces: Backoff(n) = 2^n seconds (1, 2, 4, 8, 16s for n=0..4),
// capped at 5 attempts, after which the surface reverts to its normal poll cadence. The PR-detail
// poller (ActivePrPoller) and the inbox orchestrator (InboxRefreshOrchestrator) MUST share these
// so the two surfaces can never drift on the "resolves within a couple seconds" guarantee (#655).
internal static class FastPollBurst
{
    public const int Cap = 5;

    public static TimeSpan Backoff(int attempt) => TimeSpan.FromSeconds(Math.Pow(2, attempt));
}
