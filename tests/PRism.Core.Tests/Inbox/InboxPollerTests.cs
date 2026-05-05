using FluentAssertions;
using Microsoft.Extensions.Logging;
using Moq;
using PRism.Core.Config;
using PRism.Core.Inbox;
using PRism.Core.Time;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxPollerTests
{
    // Cadence is 50ms to keep tests fast
    private const int CadenceMs = 50;

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

        var configMock = new Mock<IConfigStore>();
        configMock.Setup(c => c.Current).Returns(new AppConfig(
            new PollingConfig(30, CadenceMs / 1000 == 0 ? 0 : CadenceMs / 1000),
            AppConfig.Default.Inbox,
            AppConfig.Default.Review,
            AppConfig.Default.Iterations,
            AppConfig.Default.Logging,
            AppConfig.Default.Ui,
            AppConfig.Default.Github,
            AppConfig.Default.Llm));

        // Use a real PollingConfig with a near-zero cadence (1 second minimum for TimeSpan.FromSeconds,
        // but 0 rounds to zero which means Task.Delay(0,...) — effectively immediate)
        // Override to use 0 seconds so Task.Delay is nearly instant
        var fastConfig = new Mock<IConfigStore>();
        fastConfig.Setup(c => c.Current).Returns(AppConfig.Default with
        {
            Polling = new PollingConfig(30, 0)
        });

        var clockMock = new Mock<IClock>();
        var logMock = new Mock<ILogger<InboxPoller>>();
        var subs = new InboxSubscriberCount();

        var poller = new InboxPoller(
            orchestratorMock.Object,
            subs,
            fastConfig.Object,
            clockMock.Object,
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
            new Mock<IClock>().Object,
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
