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
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeReady());
        await poller.StartAsync(CancellationToken.None);
        poller.RequestImmediateRefresh();
        await Poll.Until(() => batch.PollCount >= 1, TimeSpan.FromSeconds(2),
            "signal should cut 30s cadence to <2s");
        Assert.True(batch.PollCount >= 1);
        await poller.StopAsync(CancellationToken.None);
        poller.Dispose();
    }

    [Fact]
    public async Task RequestImmediateRefresh_is_rate_limited_by_min_interval()
    {
        // A storm of 10 rapid signals within one minWakeInterval window must coalesce
        // to at most 2 ticks (the first natural tick + one signal-driven tick).
        // Inject 200ms so the guard window is short enough to observe in a test.
        var (poller, registry, batch) = NewPoller(minWakeInterval: TimeSpan.FromMilliseconds(200));
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeReady());
        await poller.StartAsync(CancellationToken.None);
        // Fire a storm; the semaphore max-count of 1 coalesces all into one pending wake.
        for (var i = 0; i < 10; i++) poller.RequestImmediateRefresh();
        // Wait until at least one tick has landed (may be the first natural tick before the signal).
        await Poll.Until(() => batch.PollCount >= 1, TimeSpan.FromSeconds(2),
            "first tick should land within 2s");
        // The entire storm must not produce more than 2 ticks (initial + one coalesced wake).
        Assert.True(batch.PollCount <= 2,
            $"storm of 10 signals should coalesce to ≤2 ticks but got {batch.PollCount}");
        await poller.StopAsync(CancellationToken.None);
        poller.Dispose();
    }
}

// Deterministic unit tests for the extracted ComputeWaitDelay pure method.
// No timers, no BackgroundService — pure arithmetic, always instantaneous.
public class ActivePrPollerComputeWaitDelayTests
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 28, 0, 0, 0, TimeSpan.Zero);

    // (a) Inside guard window, no pending retry, adaptive (= short cadence) < minRemaining →
    //     returns minRemaining (the guard fires, result is the remaining guard window, not ~0).
    //     Using cadence=100ms so that adaptive < minRemaining=150ms — directly proves the guard.
    [Fact]
    public void Inside_guard_window_no_retry_returns_remaining_guard_window()
    {
        var now = T0 + TimeSpan.FromMilliseconds(50);          // elapsed = 50ms
        var minWakeInterval = TimeSpan.FromMilliseconds(200);
        var cadence = TimeSpan.FromMilliseconds(100);          // < minWakeInterval → adaptive < minRemaining
        var expected = minWakeInterval - (now - T0);           // 200ms − 50ms = 150ms

        var delay = ActivePrPoller.ComputeWaitDelay(now, lastTickAt: T0, soonestNextRetry: null,
            minWakeInterval, cadence);

        Assert.Equal(expected, delay);
    }

    // (b) Outside guard window, no pending retry → returns cadence (normal healthy-PR steady state).
    [Fact]
    public void Outside_guard_window_no_retry_returns_cadence()
    {
        var now = T0 + TimeSpan.FromSeconds(5);                // elapsed >> minWakeInterval → outside window
        var minWakeInterval = TimeSpan.FromMilliseconds(200);
        var cadence = TimeSpan.FromSeconds(30);

        var delay = ActivePrPoller.ComputeWaitDelay(now, lastTickAt: T0, soonestNextRetry: null,
            minWakeInterval, cadence);

        Assert.Equal(cadence, delay);
    }

    // (c) Fast-retry pending soon (50ms away) while inside guard window (minRemaining=150ms) →
    //     adaptive=50ms < minRemaining=150ms → delay clamped up to minRemaining by the guard.
    [Fact]
    public void Inside_guard_window_fast_retry_pending_clamped_to_min_remaining()
    {
        var now = T0 + TimeSpan.FromMilliseconds(50);          // elapsed = 50ms; inside 200ms guard
        var minWakeInterval = TimeSpan.FromMilliseconds(200);
        var cadence = TimeSpan.FromSeconds(30);
        var soonestNextRetry = now + TimeSpan.FromMilliseconds(50); // due in 50ms → adaptive = 50ms
        var expectedMinRemaining = minWakeInterval - (now - T0);    // 200ms − 50ms = 150ms

        var delay = ActivePrPoller.ComputeWaitDelay(now, lastTickAt: T0, soonestNextRetry,
            minWakeInterval, cadence);

        Assert.Equal(expectedMinRemaining, delay);             // 50ms clamped up to 150ms by guard
    }

    // (d) soonestNextRetry already past + outside guard window →
    //     adaptive=0 (clamped), minRemaining<0 → delay ≤ 0 (tick-now path in WaitForNextCycleAsync).
    [Fact]
    public void Fast_retry_already_past_outside_guard_window_returns_nonpositive()
    {
        var now = T0 + TimeSpan.FromSeconds(5);                // elapsed >> minWakeInterval → outside window
        var minWakeInterval = TimeSpan.FromMilliseconds(200);
        var cadence = TimeSpan.FromSeconds(30);
        var soonestNextRetry = now - TimeSpan.FromSeconds(5);  // already past → adaptive = 0

        var delay = ActivePrPoller.ComputeWaitDelay(now, lastTickAt: T0, soonestNextRetry,
            minWakeInterval, cadence);

        Assert.True(delay <= TimeSpan.Zero, $"Expected ≤ 0 (tick-now path), got {delay}");
    }
}
