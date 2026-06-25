using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrPollerReadinessTests
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 24, 0, 0, 0, TimeSpan.Zero);

    private static ActivePrPollSnapshot Ready(string headSha, int comments, int reviews, MergeReadiness readiness) =>
        new(headSha, "b", "MERGEABLE", PrState.Open, comments, reviews, readiness);

    private static (ActivePrPoller poller, FakeReviewEventBus bus, DateTimeOffset now) NewPoller(
        FakeBatchReader reader, PrReference subscribed)
    {
        var registry = new ActivePrSubscriberRegistry();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), reader, bus, cache,
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        registry.Add("sub1", subscribed);
        return (poller, bus, T0);
    }

    [Fact]
    public async Task Publishes_on_readiness_change_with_no_head_or_comment_change()
    {
        // Same head/base/counts across ticks, only mergeStateStatus UNKNOWN -> CLEAN.
        var reader = new FakeBatchReader(
            tick1: Ready(headSha: "h", comments: 0, reviews: 0, readiness: MergeReadiness.None),
            tick2: Ready(headSha: "h", comments: 0, reviews: 0, readiness: MergeReadiness.Ready));
        var (poller, bus, now) = NewPoller(reader, subscribed: new PrReference("o", "r", 1));

        await poller.TickAsync(now, default);          // first poll seeds
        bus.Clear();
        await poller.TickAsync(now.AddSeconds(30), default);

        bus.Published.OfType<ActivePrUpdated>().Single()
            .Should().Match<ActivePrUpdated>(e => e.MergeReadinessChanged && e.MergeReadiness == MergeReadiness.Ready);
    }

    [Fact]
    public async Task Whole_tick_abort_retains_last_known_and_does_not_publish_blank()
    {
        var reader = new FakeBatchReader(
            tick1: Ready(headSha: "h", comments: 0, reviews: 0, readiness: MergeReadiness.Ready),
            throwOnTick2: new RateLimitExceededException("rate", null));
        var (poller, bus, now) = NewPoller(reader, subscribed: new PrReference("o", "r", 1));

        await poller.TickAsync(now, default);
        bus.Clear();
        await poller.TickAsync(now.AddSeconds(30), default); // aborts

        bus.Published.Should().BeEmpty(); // no blanking publish; last-known retained for next tick
    }

    // Scripted IActivePrBatchReader: returns tick1's snapshot on the first PollBatchAsync,
    // tick2's on the second; or throws on the second tick if throwOnTick2 is set. The same
    // snapshot is returned for every subscribed ref in that tick.
    private sealed class FakeBatchReader : IActivePrBatchReader
    {
        private readonly ActivePrPollSnapshot _tick1;
        private readonly ActivePrPollSnapshot? _tick2;
        private readonly Exception? _throwOnTick2;
        private int _calls;

        public FakeBatchReader(ActivePrPollSnapshot tick1, ActivePrPollSnapshot? tick2 = null, Exception? throwOnTick2 = null)
        {
            _tick1 = tick1;
            _tick2 = tick2;
            _throwOnTick2 = throwOnTick2;
        }

        public Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
            IReadOnlyList<PrReference> refs, CancellationToken ct)
        {
            var n = ++_calls;
            if (n >= 2)
            {
                if (_throwOnTick2 is not null) throw _throwOnTick2;
            }
            var snap = n == 1 ? _tick1 : (_tick2 ?? _tick1);
            IReadOnlyDictionary<PrReference, ActivePrPollSnapshot> map =
                refs.ToDictionary(r => r, _ => snap);
            return Task.FromResult(map);
        }
    }
}
