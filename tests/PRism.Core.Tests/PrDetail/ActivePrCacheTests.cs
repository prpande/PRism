using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrCacheTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 10, 0, 0, 0, TimeSpan.Zero);
    private static readonly PrReference Pr = new("o", "r", 1);

    [Fact]
    public void Empty_GetCurrent_returns_null()
    {
        var cache = new ActivePrCache(new ActivePrSubscriberRegistry());
        cache.GetCurrent(Pr).Should().BeNull();
    }

    [Fact]
    public void Update_then_GetCurrent_returns_snapshot()
    {
        var cache = new ActivePrCache(new ActivePrSubscriberRegistry());
        var snap = new ActivePrSnapshot("h1", HighestIssueCommentId: null, ObservedAt: T0);

        cache.Update(Pr, snap);

        cache.GetCurrent(Pr).Should().Be(snap);
    }

    [Fact]
    public void IsSubscribed_delegates_to_registry()
    {
        var registry = new ActivePrSubscriberRegistry();
        var cache = new ActivePrCache(registry);

        cache.IsSubscribed(Pr).Should().BeFalse("no subscribers registered yet");

        registry.Add("sub1", Pr);
        cache.IsSubscribed(Pr).Should().BeTrue();

        registry.Remove("sub1", Pr);
        cache.IsSubscribed(Pr).Should().BeFalse();
    }

    [Fact]
    public async Task ActivePrPoller_publishes_snapshot_to_cache_after_successful_poll()
    {
        // Wire-up sanity: confirms the poller's _cache.Update call lands in the singleton
        // the rest of the system reads from. Asserts the head-SHA path; HighestIssueCommentId
        // remains null in S4 production (see IActivePrCache class comment).
        var registry = new ActivePrSubscriberRegistry();
        var review = new FakePollerReviewService();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(registry, review, bus, cache, NullLogger<ActivePrPoller>.Instance);

        registry.Add("sub1", Pr);
        review.SetSnapshot(Pr, new ActivePrPollSnapshot("h-fresh", "MERGEABLE", "OPEN", 0, 0));

        await poller.TickAsync(T0, default);

        var snap = cache.GetCurrent(Pr);
        snap.Should().NotBeNull();
        snap!.HeadSha.Should().Be("h-fresh");
        snap.HighestIssueCommentId.Should().BeNull("poller does not yet compute the highest comment id");
        snap.ObservedAt.Should().Be(T0);
    }
}
