using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// #323 item 1 — a throwing ActivePrUpdated subscriber must not knock a healthy PR into
// backoff. The poller publishes inside its per-PR try (ActivePrPoller.cs:154) *before*
// advancing LastHeadSha (:166); without bus-level fault isolation a subscriber throw
// propagates into the poller's broad catch (:187), applying backoff and skipping the head
// advance — so the same event re-fires every tick. This test uses the REAL ReviewEventBus
// (not FakeReviewEventBus, whose Subscribe is a NullDisposable no-op that would never invoke
// the throwing handler → a vacuous pass).
public class ActivePrPollerSubscriberFaultTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 7, 0, 0, 0, TimeSpan.Zero);

    private static ActivePrPollSnapshot Snapshot(string headSha = "h1", string baseSha = "b1", int commentCount = 0, string prState = "OPEN") =>
        new(headSha, baseSha, "MERGEABLE", prState, commentCount, 0);

    [Fact]
    public async Task Throwing_subscriber_does_not_backoff_healthy_pr_or_re_fire_the_event()
    {
        var registry = new ActivePrSubscriberRegistry();
        var review = new FakePollerReviewService();
        var bus = new ReviewEventBus();           // REAL bus — delivers to subscribers
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(
            registry, review, bus, cache,
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));

        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1"));

        var published = 0;
        var throwerInvoked = false;
        // Counting handler first so it observes every publish even on main (where the thrower
        // below would otherwise preempt dispatch). Throwing handler second.
        bus.Subscribe<ActivePrUpdated>(_ => published++);
        bus.Subscribe<ActivePrUpdated>(_ =>
        {
            throwerInvoked = true;
            throw new InvalidOperationException("subscriber boom");
        });

        await poller.TickAsync(T0, default);
        // Second tick with the SAME snapshot. The exact offset is irrelevant: with the fix no
        // backoff is ever scheduled (NextRetryAt stays null), so the second poll always runs; on
        // main the spurious backoff would gate it regardless of how far ahead this tick is.
        await poller.TickAsync(T0.AddSeconds(30), default);

        throwerInvoked.Should().BeTrue("the real bus must actually invoke the throwing subscriber (guards against a vacuous no-op-bus test)");
        review.CallCount(pr).Should().Be(2,
            "a throwing subscriber must not push a healthy PR into backoff; the second tick must still poll");
        published.Should().Be(1,
            "tick 1 advanced LastHeadSha, so the unchanged second tick publishes nothing — the event does not re-fire");
    }
}
