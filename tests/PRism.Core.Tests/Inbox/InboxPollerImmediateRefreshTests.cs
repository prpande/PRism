using System.Diagnostics;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PRism.Core.Config;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

// S6 PR2 Task 2.4 — RequestImmediateRefresh cuts a 60s cadence wait short to <500ms.
// Bound the whole fact's runtime via a 5s linked CancellationTokenSource so a regression
// (signal never wired) fails fast instead of hanging.
public sealed class InboxPollerImmediateRefreshTests
{
    [Fact]
    public async Task RequestImmediateRefresh_Signals_NextRefresh_Within500ms()
    {
        // 60s cadence — without the signal, the second RefreshAsync wouldn't fire until ~60s.
        var orchestrator = new Mock<IInboxRefreshOrchestrator>();
        var firstTick = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondTick = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var tickCount = 0;
        orchestrator
            .Setup(o => o.RefreshAsync(It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                var n = Interlocked.Increment(ref tickCount);
                if (n == 1) firstTick.TrySetResult();
                else if (n == 2) secondTick.TrySetResult();
                return Task.CompletedTask;
            });

        var config = new Mock<IConfigStore>();
        config.Setup(c => c.Current).Returns(AppConfig.Default with
        {
            Polling = new PollingConfig(30, 60),  // 60s inbox cadence
        });

        var subs = new InboxSubscriberCount();
        using var poller = new InboxPoller(
            orchestrator.Object,
            subs,
            config.Object,
            NullLogger<InboxPoller>.Instance);

        using var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await poller.StartAsync(stopCts.Token);

        try
        {
            // Trigger the first tick by registering a subscriber.
            subs.Increment();
            await firstTick.Task.WaitAsync(TimeSpan.FromSeconds(3), stopCts.Token);

            // Now the poller is sitting in the 60s Task.Delay. Fire the signal and
            // measure how long until the second RefreshAsync invocation lands.
            var stopwatch = Stopwatch.StartNew();
            poller.RequestImmediateRefresh();
            await secondTick.Task.WaitAsync(TimeSpan.FromSeconds(3), stopCts.Token);
            stopwatch.Stop();

            stopwatch.ElapsedMilliseconds.Should().BeLessThan(500,
                "the signal must cut the 60s cadence short — anything close to 60s means the race isn't wired");
        }
        finally
        {
            await stopCts.CancelAsync();
            await poller.StopAsync(default);
        }
    }

    [Fact]
    public void RequestImmediateRefresh_DuplicateSignals_DoNotThrow()
    {
        // Capacity-1 semaphore coalesces; SemaphoreFullException must be swallowed
        // so callers (the endpoint) don't crash when the previous signal hasn't been
        // consumed yet.
        var orchestrator = new Mock<IInboxRefreshOrchestrator>();
        var config = new Mock<IConfigStore>();
        config.Setup(c => c.Current).Returns(AppConfig.Default);

        using var poller = new InboxPoller(
            orchestrator.Object,
            new InboxSubscriberCount(),
            config.Object,
            NullLogger<InboxPoller>.Instance);

        var act = () =>
        {
            poller.RequestImmediateRefresh();
            poller.RequestImmediateRefresh();
            poller.RequestImmediateRefresh();
        };
        act.Should().NotThrow();
    }
}
