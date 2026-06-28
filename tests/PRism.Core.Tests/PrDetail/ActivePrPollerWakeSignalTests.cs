using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// Task 4: ActivePrPoller wake signal + min-interval guard.
// Exercises the real BackgroundService loop (StartAsync) with an injected short minWakeInterval
// so assertions are on the guard logic, not wall-clock cadence.
public class ActivePrPollerWakeSignalTests
{
    private static PrReference Pr(int n) => new("o", "r", n);

    // Creates a poller with 30s natural cadence (Production env; no PRISM_POLLER_CADENCE_SECONDS)
    // and an injected minWakeInterval (default → 3s in prod; short value for guard tests).
    // Batch always returns a Ready snapshot so ticks don't schedule fast-retries and mess up PollCount.
    private static (ActivePrPoller poller, ActivePrSubscriberRegistry registry, FakeActivePrBatchReader batch)
        NewPoller(TimeSpan minWakeInterval = default)
    {
        var registry = new ActivePrSubscriberRegistry();
        var batch = new FakeActivePrBatchReader();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), batch, bus, cache,
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"),
            minWakeInterval);
        return (poller, registry, batch);
    }

    private static ActivePrPollSnapshot MakeReady() =>
        new("h1", "b1", "CLEAN", PrState.Open, 0, 0, MergeReadiness.Ready, IsDraft: false);

    [Fact]
    public async Task RequestImmediateRefresh_wakes_the_loop_within_two_seconds()
    {
        // Poller has 30s natural cadence; a signal must cause it to tick in <2s.
        var (poller, registry, batch) = NewPoller();
        using var cts = new CancellationTokenSource();
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeReady());
        var run = poller.StartAsync(cts.Token);
        poller.RequestImmediateRefresh();
        await Poll.Until(() => batch.PollCount >= 1, TimeSpan.FromSeconds(2),
            "signal should cut 30s cadence to <2s");
        Assert.True(batch.PollCount >= 1);
        cts.Cancel();
        await run;
    }

    [Fact]
    public async Task RequestImmediateRefresh_is_rate_limited_by_min_interval()
    {
        // A storm of 10 rapid signals within one minWakeInterval window must coalesce
        // to at most 2 ticks (the first natural tick + one signal-driven tick).
        // Inject 200ms so the guard window is short enough to observe in a test.
        var (poller, registry, batch) = NewPoller(minWakeInterval: TimeSpan.FromMilliseconds(200));
        using var cts = new CancellationTokenSource();
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeReady());
        var run = poller.StartAsync(cts.Token);
        // Fire a storm; the semaphore max-count of 1 coalesces all into one pending wake.
        for (var i = 0; i < 10; i++) poller.RequestImmediateRefresh();
        // Wait until at least one tick has landed (may be the first natural tick before the signal).
        await Poll.Until(() => batch.PollCount >= 1, TimeSpan.FromSeconds(2),
            "first tick should land within 2s");
        // The entire storm must not produce more than 2 ticks (initial + one coalesced wake).
        Assert.True(batch.PollCount <= 2,
            $"storm of 10 signals should coalesce to ≤2 ticks but got {batch.PollCount}");
        cts.Cancel();
        await run;
    }
}
