using FluentAssertions;
using Microsoft.Extensions.Logging;
using Moq;
using PRism.Core.Config;
using PRism.Core.Inbox;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxPollerTests
{
    private static (
        InboxPoller Poller,
        Mock<IInboxRefreshOrchestrator> OrchestratorMock,
        InboxSubscriberCount Subs)
        Build()
    {
        var orchestratorMock = new Mock<IInboxRefreshOrchestrator>();
        orchestratorMock
            .Setup(o => o.RefreshAsync(It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        // Use a real PollingConfig with a near-zero cadence (1 second minimum for TimeSpan.FromSeconds,
        // but 0 rounds to zero which means Task.Delay(0,...) — effectively immediate)
        var fastConfig = new Mock<IConfigStore>();
        fastConfig.Setup(c => c.Current).Returns(AppConfig.Default with
        {
            Polling = new PollingConfig(30, 0)
        });

        var logMock = new Mock<ILogger<InboxPoller>>();
        var subs = new InboxSubscriberCount();

        var poller = new InboxPoller(
            orchestratorMock.Object,
            subs,
            fastConfig.Object,
            logMock.Object);

        return (poller, orchestratorMock, subs);
    }

    private static async Task StopAsync(InboxPoller poller, CancellationTokenSource cts)
    {
        await cts.CancelAsync();
        await poller.StopAsync(default);
    }

    [Fact]
    public async Task Subscriber_count_zero_no_refresh_fires()
    {
        var (poller, orchestratorMock, _) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        await Task.Delay(200);

        await StopAsync(poller, cts);

        orchestratorMock.Verify(o => o.RefreshAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task First_subscriber_kicks_immediate_refresh()
    {
        var (poller, orchestratorMock, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        await Task.Delay(200);
        await StopAsync(poller, cts);

        orchestratorMock.Verify(o => o.RefreshAsync(It.IsAny<CancellationToken>()), Times.AtLeastOnce);
    }

    [Fact]
    public async Task Cadence_continues_while_subscriber_present()
    {
        var (poller, orchestratorMock, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        // With cadence = 0 (Task.Delay(0,...)), many ticks fire fast
        await Task.Delay(300);
        await StopAsync(poller, cts);

        orchestratorMock.Verify(o => o.RefreshAsync(It.IsAny<CancellationToken>()), Times.AtLeast(3));
    }

    [Fact]
    public async Task Decrement_to_zero_pauses_refresh()
    {
        var (poller, orchestratorMock, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait for at least one tick
        await Task.Delay(100);
        var callsAfterFirstTick = orchestratorMock.Invocations
            .Count(i => i.Method.Name == nameof(IInboxRefreshOrchestrator.RefreshAsync));

        // Now remove subscriber
        subs.Decrement();

        // Reset mock count tracking by capturing calls at this point
        var callsBeforePause = orchestratorMock.Invocations
            .Count(i => i.Method.Name == nameof(IInboxRefreshOrchestrator.RefreshAsync));

        // Wait several cadence durations — no more calls should fire
        await Task.Delay(200);
        var callsAfterPause = orchestratorMock.Invocations
            .Count(i => i.Method.Name == nameof(IInboxRefreshOrchestrator.RefreshAsync));

        await StopAsync(poller, cts);

        // At most one extra call can race through (was in-flight when Decrement happened)
        (callsAfterPause - callsBeforePause).Should().BeLessOrEqualTo(1);
    }

    [Fact]
    public async Task Resume_after_pause_kicks_immediate_refresh()
    {
        var (poller, orchestratorMock, subs) = Build();
        using var cts = new CancellationTokenSource();

        await poller.StartAsync(cts.Token);

        // First subscriber cycle
        subs.Increment();
        await Task.Delay(100);
        subs.Decrement();

        // Allow any in-flight call to settle
        await Task.Delay(50);
        var callsAtPause = orchestratorMock.Invocations
            .Count(i => i.Method.Name == nameof(IInboxRefreshOrchestrator.RefreshAsync));

        // Re-subscribe
        subs.Increment();
        await Task.Delay(200);

        await StopAsync(poller, cts);

        var callsAfterResume = orchestratorMock.Invocations
            .Count(i => i.Method.Name == nameof(IInboxRefreshOrchestrator.RefreshAsync));

        callsAfterResume.Should().BeGreaterThan(callsAtPause,
            "a new subscriber should have triggered at least one additional refresh");
    }

    [Fact]
    public async Task Refresh_exception_does_not_break_poller()
    {
        var orchestratorMock = new Mock<IInboxRefreshOrchestrator>();
        var callCount = 0;
        orchestratorMock
            .Setup(o => o.RefreshAsync(It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                callCount++;
                if (callCount == 1) throw new InvalidOperationException("transient error");
                return Task.CompletedTask;
            });

        var fastConfig = new Mock<IConfigStore>();
        fastConfig.Setup(c => c.Current).Returns(AppConfig.Default with
        {
            Polling = new PollingConfig(30, 0)
        });

        var subs = new InboxSubscriberCount();
        var poller = new InboxPoller(
            orchestratorMock.Object,
            subs,
            fastConfig.Object,
            new Mock<ILogger<InboxPoller>>().Object);

        using var cts = new CancellationTokenSource();
        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait long enough for both the exception call and the successful call
        await Task.Delay(300);
        await StopAsync(poller, cts);

        // Both calls happened (exception + at least one success)
        orchestratorMock.Verify(o => o.RefreshAsync(It.IsAny<CancellationToken>()), Times.AtLeast(2));
    }

    [Fact]
    public async Task RefreshAsync_throws_RateLimitExceededException_then_next_delay_is_max_of_retry_after_and_cadence()
    {
        var orchestratorMock = new Mock<IInboxRefreshOrchestrator>();
        var callTimes = new List<DateTime>();
        var callCount = 0;
        orchestratorMock
            .Setup(o => o.RefreshAsync(It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                callTimes.Add(DateTime.UtcNow);
                callCount++;
                if (callCount == 1)
                {
                    throw new RateLimitExceededException("test", TimeSpan.FromMilliseconds(300));
                }
                return Task.CompletedTask;
            });

        // Cadence = 1s; Retry-After = 300ms. The poller should wait max(retryAfter, cadence) = 1s.
        // Inverting the test assumption: if the code used cadence-only it would still wait 1s,
        // so we instead invert: cadence = 100ms, retryAfter = 400ms. Expected delay between
        // call 1 and call 2 is ~400ms (retryAfter > cadence). Bug behaviour would yield ~100ms.
        callTimes.Clear();
        callCount = 0;
        orchestratorMock
            .Setup(o => o.RefreshAsync(It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                callTimes.Add(DateTime.UtcNow);
                callCount++;
                if (callCount == 1)
                {
                    throw new RateLimitExceededException("test", TimeSpan.FromMilliseconds(400));
                }
                return Task.CompletedTask;
            });

        var fastConfig = new Mock<IConfigStore>();
        fastConfig.Setup(c => c.Current).Returns(AppConfig.Default with
        {
            // PollingConfig.InboxSeconds is int seconds; 0 → cadence = 0s (effectively immediate).
            // With cadence = 0, max(retryAfter=400ms, cadence=0) = 400ms — that's the gap we expect.
            // Bug behaviour ignores RetryAfter → gap ≈ 0ms.
            Polling = new PollingConfig(30, 0)
        });

        var subs = new InboxSubscriberCount();
        var poller = new InboxPoller(
            orchestratorMock.Object,
            subs,
            fastConfig.Object,
            new Mock<ILogger<InboxPoller>>().Object);

        using var cts = new CancellationTokenSource();
        await poller.StartAsync(cts.Token);
        subs.Increment();

        // Wait long enough for: tick #1 (rate-limited, ~immediate) + 400ms Retry-After delay + tick #2.
        await Task.Delay(800);
        await StopAsync(poller, cts);

        callTimes.Should().HaveCountGreaterOrEqualTo(2,
            "the poller should have retried after honoring Retry-After");

        var gap = callTimes[1] - callTimes[0];
        gap.Should().BeGreaterOrEqualTo(TimeSpan.FromMilliseconds(300),
            "the second refresh must wait at least the Retry-After window (allowing for scheduler jitter)");
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
