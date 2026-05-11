using FluentAssertions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrPollerBackoffTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 7, 0, 0, 0, TimeSpan.Zero);

    private static (ActivePrPoller poller, FakePollerReviewService review, FakeReviewEventBus bus, ActivePrSubscriberRegistry registry, IActivePrCache cache) Build()
    {
        var registry = new ActivePrSubscriberRegistry();
        var review = new FakePollerReviewService();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(
            registry, review, bus, cache,
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        return (poller, review, bus, registry, cache);
    }

    private static ActivePrPollSnapshot Snapshot(string headSha = "h1", int commentCount = 0) =>
        new(headSha, "MERGEABLE", "OPEN", commentCount, 0);

    [Fact]
    public async Task Healthy_pr_continues_to_poll_while_other_pr_is_in_backoff()
    {
        var (poller, review, _, registry, _) = Build();
        var prA = new PrReference("o", "r", 1);
        var prB = new PrReference("o", "r", 2);
        registry.Add("sub1", prA);
        registry.Add("sub1", prB);
        review.SetThrows(prA, new HttpRequestException("500"));
        review.SetSnapshot(prB, Snapshot());

        await poller.TickAsync(T0, default);
        review.CallCount(prA).Should().Be(1);
        review.CallCount(prB).Should().Be(1);

        // Tick again 1 second later. PR A's backoff (60s) hasn't elapsed → skipped.
        // PR B has no backoff → polled again.
        await poller.TickAsync(T0.AddSeconds(1), default);
        review.CallCount(prA).Should().Be(1, "PR A is in backoff and should be skipped");
        review.CallCount(prB).Should().Be(2, "PR B is healthy and continues to poll");
    }

    [Fact]
    public async Task Backoff_resets_after_successful_poll()
    {
        var (poller, review, _, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetThrows(pr, new HttpRequestException("500"));

        // Tick 1: error → backoff 60s.
        await poller.TickAsync(T0, default);
        review.CallCount(pr).Should().Be(1);

        // Tick at T0+120 (past 60s backoff): success → ConsecutiveErrors=0, NextRetryAt=null.
        review.SetSnapshot(pr, Snapshot());
        await poller.TickAsync(T0.AddSeconds(120), default);
        review.CallCount(pr).Should().Be(2);

        // New error: ConsecutiveErrors should reset to 1 (not climb to 2). Backoff = 60s.
        review.SetThrows(pr, new HttpRequestException("500"));
        await poller.TickAsync(T0.AddSeconds(121), default);
        review.CallCount(pr).Should().Be(3);

        // Confirm backoff was 60s (reset worked) by polling at T0+182.
        // If reset failed and ConsecutiveErrors had climbed to 3, backoff would be 240s
        // and the call below would be skipped.
        await poller.TickAsync(T0.AddSeconds(182), default);
        review.CallCount(pr).Should().Be(4, "backoff reset to 60s after successful poll, so PR is polled again at T0+182");
    }

    [Fact]
    public async Task Single_pr_exception_does_not_block_other_prs()
    {
        var (poller, review, _, registry, _) = Build();
        var prA = new PrReference("o", "r", 1);
        var prB = new PrReference("o", "r", 2);
        registry.Add("sub1", prA);
        registry.Add("sub1", prB);
        review.SetThrows(prA, new InvalidOperationException("synchronous boom"));
        review.SetSnapshot(prB, Snapshot());

        await poller.TickAsync(T0, default);
        review.CallCount(prA).Should().Be(1);
        review.CallCount(prB).Should().Be(1, "PR B must poll within the same tick despite PR A throwing");
    }

    [Fact]
    public async Task FirstSuccessfulPoll_PublishesActivePrUpdated_EvenWithoutDeltas()
    {
        // Spec § 5.6 + frontend `useFirstActivePrPollComplete`: the gate hook
        // backing the Mark-all-read button needs the first successful poll
        // for a newly-subscribed PR to surface as a `pr-updated` SSE event.
        // Without this, a quiet PR (no head SHA or comment count changes)
        // would never publish, leaving the gate closed indefinitely. Both
        // delta flags are false because there is nothing to compare against
        // on the first poll — consumers treat the first event as a hydration
        // signal, not a delta announcement.
        var (poller, review, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));

        await poller.TickAsync(T0, default);

        bus.Published.Should().ContainSingle();
        var evt = (ActivePrUpdated)bus.Published[0];
        evt.PrRef.Should().Be(pr);
        evt.HeadShaChanged.Should().BeFalse();
        evt.CommentCountChanged.Should().BeFalse();
        evt.NewHeadSha.Should().BeNull();
        evt.NewCommentCount.Should().BeNull();
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_when_head_sha_changes()
    {
        var (poller, review, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        review.SetSnapshot(pr, Snapshot(headSha: "h1"));
        await poller.TickAsync(T0, default);  // first poll publishes a hydration event
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");
        var firstEvt = (ActivePrUpdated)bus.Published[0];
        firstEvt.HeadShaChanged.Should().BeFalse("the first event has no prior state to diff against");

        review.SetSnapshot(pr, Snapshot(headSha: "h2"));
        await poller.TickAsync(T0.AddSeconds(30), default);
        bus.Published.Should().HaveCount(2);
        var deltaEvt = (ActivePrUpdated)bus.Published[1];
        deltaEvt.PrRef.Should().Be(pr);
        deltaEvt.HeadShaChanged.Should().BeTrue();
        deltaEvt.NewHeadSha.Should().Be("h2");
        deltaEvt.CommentCountChanged.Should().BeFalse();
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_when_comment_count_changes()
    {
        var (poller, review, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));
        await poller.TickAsync(T0, default);
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");

        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 3));
        await poller.TickAsync(T0.AddSeconds(30), default);
        bus.Published.Should().HaveCount(2);
        var deltaEvt = (ActivePrUpdated)bus.Published[1];
        deltaEvt.HeadShaChanged.Should().BeFalse();
        deltaEvt.CommentCountChanged.Should().BeTrue();
        deltaEvt.NewCommentCount.Should().Be(3);
    }

    [Fact]
    public async Task Does_not_publish_again_when_snapshot_is_unchanged()
    {
        var (poller, review, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));

        await poller.TickAsync(T0, default);
        await poller.TickAsync(T0.AddSeconds(30), default);
        await poller.TickAsync(T0.AddSeconds(60), default);
        bus.Published.Should().ContainSingle("the first poll publishes a hydration event; identical subsequent snapshots do not");
    }
}
