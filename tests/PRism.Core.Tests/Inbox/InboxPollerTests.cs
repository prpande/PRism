using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Config;
using PRism.Core.Inbox;
using PRism.Core.Tests.PrDetail;
using PRism.Core.Tests.TestHelpers;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxPollerTests
{
    private static FakeConfigStore FastConfig() =>
        // Near-zero cadence (0 rounds toward the poller's 1s clamp) for fast ticks.
        new() { Current = AppConfig.Default with { Polling = new PollingConfig(30, 0) } };

    private static (
        InboxPoller Poller,
        FakeInboxRefreshOrchestrator Orchestrator,
        InboxSubscriberCount Subs)
        Build()
    {
        var orchestrator = new FakeInboxRefreshOrchestrator();
        var subs = new InboxSubscriberCount();

        var poller = new InboxPoller(
            orchestrator,
            subs,
            FastConfig(),
            NullLogger<InboxPoller>.Instance);

        return (poller, orchestrator, subs);
    }

    private static async Task StopAsync(InboxPoller poller, CancellationTokenSource cts)
    {
        await cts.CancelAsync();
        await poller.StopAsync(default);
    }

    [Fact]
    public async Task Subscriber_count_zero_no_refresh_fires()
    {
        var (poller, orchestrator, _) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        await Task.Delay(200);

        await StopAsync(poller, cts);

        orchestrator.RefreshCalls.Should().Be(0);
    }

    [Fact]
    public async Task First_subscriber_kicks_immediate_refresh()
    {
        var (poller, orchestrator, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        await Task.Delay(200);
        await StopAsync(poller, cts);

        orchestrator.RefreshCalls.Should().BeGreaterOrEqualTo(1);
    }

    [Fact]
    public async Task Cadence_continues_while_subscriber_present()
    {
        var (poller, orchestrator, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Cadence is clamped to a 1s floor (defensive against config typos), so
        // wait long enough to reliably observe at least 2 ticks across that floor.
        await Task.Delay(2500);
        await StopAsync(poller, cts);

        orchestrator.RefreshCalls.Should().BeGreaterOrEqualTo(2);
    }

    [Fact]
    public async Task Decrement_to_zero_pauses_refresh()
    {
        var (poller, orchestrator, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait for at least one tick
        await Task.Delay(100);

        // Now remove subscriber
        subs.Decrement();

        // Capture the call count at the pause point.
        var callsBeforePause = orchestrator.RefreshCalls;

        // Wait several cadence durations — no more calls should fire
        await Task.Delay(200);
        var callsAfterPause = orchestrator.RefreshCalls;

        await StopAsync(poller, cts);

        // At most one extra call can race through (was in-flight when Decrement happened)
        (callsAfterPause - callsBeforePause).Should().BeLessOrEqualTo(1);
    }

    [Fact]
    public async Task Resume_after_pause_kicks_immediate_refresh()
    {
        var (poller, orchestrator, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);

        // First subscriber cycle
        subs.Increment();
        await Task.Delay(100);
        subs.Decrement();

        // Allow any in-flight call to settle
        await Task.Delay(50);
        var callsAtPause = orchestrator.RefreshCalls;

        // Re-subscribe. The InboxSeconds=0 cadence is clamped to a 1s floor, so we
        // must wait > 1s for the immediate refresh on resume to fire (the poller is
        // sitting in Task.Delay(1s) when the new Increment arrives).
        subs.Increment();
        await Task.Delay(1500);

        await StopAsync(poller, cts);

        var callsAfterResume = orchestrator.RefreshCalls;

        callsAfterResume.Should().BeGreaterThan(callsAtPause,
            "a new subscriber should have triggered at least one additional refresh");
    }

    [Fact]
    public async Task Refresh_exception_does_not_break_poller()
    {
        var orchestrator = new FakeInboxRefreshOrchestrator();
        var callCount = 0;
        orchestrator.RefreshOverride = _ =>
        {
            callCount++;
            if (callCount == 1) throw new InvalidOperationException("transient error");
            return Task.CompletedTask;
        };

        var subs = new InboxSubscriberCount();
        var poller = new InboxPoller(
            orchestrator,
            subs,
            FastConfig(),
            NullLogger<InboxPoller>.Instance);

        using var cts = new CancellationTokenSource();
        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Cadence is clamped to a 1s floor; wait long enough for the exception
        // call plus at least one successful retry tick across that floor.
        await Task.Delay(2500);
        await StopAsync(poller, cts);

        // Both calls happened (exception + at least one success)
        orchestrator.RefreshCalls.Should().BeGreaterOrEqualTo(2);
    }

    [Fact]
    public async Task RefreshAsync_throws_RateLimitExceededException_then_next_delay_is_max_of_retry_after_and_cadence()
    {
        var orchestrator = new FakeInboxRefreshOrchestrator();
        var callTimes = new List<DateTime>();
        var callCount = 0;
        // Cadence = 0 (clamped to a 1s floor); Retry-After = 400ms. The poller should wait
        // max(retryAfter, clampedCadence). The gap between call 1 (rate-limited) and call 2
        // must be at least the Retry-After window; a bug that ignored Retry-After would yield ~0ms.
        orchestrator.RefreshOverride = _ =>
        {
            callTimes.Add(DateTime.UtcNow);
            callCount++;
            if (callCount == 1)
            {
                throw new RateLimitExceededException("test", TimeSpan.FromMilliseconds(400));
            }
            return Task.CompletedTask;
        };

        var subs = new InboxSubscriberCount();
        var poller = new InboxPoller(
            orchestrator,
            subs,
            FastConfig(),
            NullLogger<InboxPoller>.Instance);

        using var cts = new CancellationTokenSource();
        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait long enough for: tick #1 (rate-limited) + max(retryAfter=400ms, clampedCadence=1s)
        // delay + tick #2. Cadence is clamped to a 1s floor, so allow ample slack.
        await Task.Delay(2500);
        await StopAsync(poller, cts);

        callTimes.Should().HaveCountGreaterOrEqualTo(2,
            "the poller should have retried after honoring Retry-After");

        var gap = callTimes[1] - callTimes[0];
        gap.Should().BeGreaterOrEqualTo(TimeSpan.FromMilliseconds(300),
            "the second refresh must wait at least the Retry-After window (allowing for scheduler jitter)");
    }

    [Fact]
    public async Task RefreshAsync_when_InboxSeconds_zero_clamps_delay_to_one_second()
    {
        // Regression: Polling.InboxSeconds=0 used to produce a tight loop because
        // TimeSpan.FromSeconds(0) → Task.Delay(0,...) returns immediately. The
        // poller now clamps to a 1s minimum (defensive against config typos).
        var orchestrator = new FakeInboxRefreshOrchestrator();
        var callTimes = new List<DateTime>();
        orchestrator.RefreshOverride = _ =>
        {
            callTimes.Add(DateTime.UtcNow);
            return Task.CompletedTask;
        };

        var subs = new InboxSubscriberCount();
        var poller = new InboxPoller(
            orchestrator,
            subs,
            FastConfig(),
            NullLogger<InboxPoller>.Instance);

        using var cts = new CancellationTokenSource();
        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait long enough to reliably observe two ticks across the 1s clamp.
        await Task.Delay(2500);
        await StopAsync(poller, cts);

        callTimes.Should().HaveCountGreaterOrEqualTo(2,
            "at least one refresh should fire after the clamp window");

        var gap = callTimes[1] - callTimes[0];
        gap.Should().BeGreaterOrEqualTo(TimeSpan.FromMilliseconds(900),
            "with InboxSeconds=0 the cadence must be clamped to ~1s, not 0ms (tight-loop bug)");
    }

    [Fact]
    public async Task RefreshAsync_when_InboxSeconds_negative_does_not_throw_and_clamps()
    {
        // Regression: Polling.InboxSeconds<0 used to throw ArgumentOutOfRangeException
        // out of Task.Delay(negative TimeSpan), killing the BackgroundService. The
        // poller now clamps to a 1s minimum so negative values are tolerated.
        var orchestrator = new FakeInboxRefreshOrchestrator();
        var callTimes = new List<DateTime>();
        orchestrator.RefreshOverride = _ =>
        {
            callTimes.Add(DateTime.UtcNow);
            return Task.CompletedTask;
        };

        var negativeCadence = new FakeConfigStore
        {
            Current = AppConfig.Default with { Polling = new PollingConfig(30, -10) },
        };

        var subs = new InboxSubscriberCount();
        var poller = new InboxPoller(
            orchestrator,
            subs,
            negativeCadence,
            NullLogger<InboxPoller>.Instance);

        using var cts = new CancellationTokenSource();
        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait long enough for two ticks across the 1s clamp. If the negative
        // TimeSpan reached Task.Delay, ExecuteAsync would crash and tick #2
        // would never fire.
        await Task.Delay(2500);

        // StopAsync must complete cleanly — a crashed ExecuteAsync would
        // surface its exception here.
        var stop = async () => await StopAsync(poller, cts);
        await stop.Should().NotThrowAsync();

        callTimes.Should().HaveCountGreaterOrEqualTo(2,
            "negative InboxSeconds must clamp; the poller must keep ticking after the first refresh");
    }

    [Fact]
    public async Task Cancellation_stops_poller_cleanly()
    {
        var (poller, _, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        await Task.Delay(50);

        // Cancel and stop — should not throw
        var act = async () =>
        {
            await cts.CancelAsync();
            await poller.StopAsync(default);
        };

        await act.Should().NotThrowAsync();
    }
}
