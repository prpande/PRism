using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// Asserts the s_pollSnapshotLog delegate emits the expected fields per poll.
// Substring matches against the rendered FormattedMessage; PRism doesn't have
// a structured-field assertion helper today and the rendered template is the
// shape the on-disk logger ultimately writes.
public class ActivePrPollerSnapshotLogTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 19, 0, 0, 0, TimeSpan.Zero);

    private sealed class CapturingLogger : ILogger<ActivePrPoller>
    {
        public ConcurrentBag<string> Messages { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            if (eventId.Id == 3) Messages.Add(formatter(state, exception));
        }
        private sealed class NullScope : IDisposable { public static readonly NullScope Instance = new(); public void Dispose() { } }
    }

    private static (ActivePrPoller poller, FakePollerReviewService review, CapturingLogger logger, ActivePrSubscriberRegistry registry) Build()
    {
        var registry = new ActivePrSubscriberRegistry();
        var review = new FakePollerReviewService();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var logger = new CapturingLogger();
        var poller = new ActivePrPoller(
            registry, review, bus, cache,
            logger,
            new FakeHostEnvironment("Production"));
        return (poller, review, logger, registry);
    }

    private static ActivePrPollSnapshot Snapshot(string headSha = "h1", int commentCount = 0) =>
        new(headSha, "MERGEABLE", "OPEN", commentCount, 0);

    [Fact]
    public async Task T_INV_1_emits_one_snapshot_line_per_successful_poll()
    {
        var (poller, review, logger, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1"));

        await poller.TickAsync(T0, default);

        logger.Messages.Should().ContainSingle();
        logger.Messages.Single().Should().Contain("Active-PR poll snapshot");
    }

    [Fact]
    public async Task T_INV_2_first_poll_after_subscribe_has_firstPoll_true_and_prevHead_null()
    {
        var (poller, review, logger, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1"));

        await poller.TickAsync(T0, default);

        var line = logger.Messages.Single();
        line.Should().Contain("firstPoll=True");
        line.Should().Contain("headChanged=False");
        line.Should().Contain("commentChanged=False");
        line.Should().Contain("head=h1");
        // PrevHeadSha is null on first poll. LoggerMessage renders null as "(null)"
        // (not as an empty string — the plan comment was incorrect).
        line.Should().Contain("prevHead=(null)");
    }

    [Fact]
    public async Task T_INV_3_second_poll_with_head_delta_has_firstPoll_false_prevHead_set_and_headChanged_true()
    {
        var (poller, review, logger, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        review.SetSnapshot(pr, Snapshot(headSha: "h1"));
        await poller.TickAsync(T0, default);  // first poll captures h1

        review.SetSnapshot(pr, Snapshot(headSha: "h2"));
        await poller.TickAsync(T0.AddSeconds(30), default);  // second poll observes delta

        logger.Messages.Should().HaveCount(2);
        var deltaLine = logger.Messages.Single(m => m.Contains("head=h2", StringComparison.Ordinal));
        deltaLine.Should().Contain("firstPoll=False");
        deltaLine.Should().Contain("prevHead=h1");
        deltaLine.Should().Contain("head=h2");
        deltaLine.Should().Contain("headChanged=True");
        deltaLine.Should().Contain("commentChanged=False");
    }
}
