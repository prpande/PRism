using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrPollerBackoffTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 7, 0, 0, 0, TimeSpan.Zero);

    private static (ActivePrPoller poller, FakePollerReviewService review, FakeReviewEventBus bus, ActivePrSubscriberRegistry registry) Build()
    {
        var registry = new ActivePrSubscriberRegistry();
        var review = new FakePollerReviewService();
        var bus = new FakeReviewEventBus();
        var poller = new ActivePrPoller(registry, review, bus, NullLogger<ActivePrPoller>.Instance);
        return (poller, review, bus, registry);
    }

    private static ActivePrPollSnapshot Snapshot(string headSha = "h1", int commentCount = 0) =>
        new(headSha, "MERGEABLE", "OPEN", commentCount, 0);

    [Fact]
    public async Task Healthy_pr_continues_to_poll_while_other_pr_is_in_backoff()
    {
        var (poller, review, _, registry) = Build();
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
        var (poller, review, _, registry) = Build();
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
        var (poller, review, _, registry) = Build();
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
    public async Task Publishes_ActivePrUpdated_when_head_sha_changes()
    {
        var (poller, review, bus, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        review.SetSnapshot(pr, Snapshot(headSha: "h1"));
        await poller.TickAsync(T0, default);  // first poll seeds state — no publish
        bus.Published.Should().BeEmpty("first poll seeds state without publishing");

        review.SetSnapshot(pr, Snapshot(headSha: "h2"));
        await poller.TickAsync(T0.AddSeconds(30), default);
        bus.Published.Should().ContainSingle();
        var evt = (ActivePrUpdated)bus.Published[0];
        evt.PrRef.Should().Be(pr);
        evt.HeadShaChanged.Should().BeTrue();
        evt.NewHeadSha.Should().Be("h2");
        evt.CommentCountChanged.Should().BeFalse();
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_when_comment_count_changes()
    {
        var (poller, review, bus, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));
        await poller.TickAsync(T0, default);
        bus.Published.Should().BeEmpty();

        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 3));
        await poller.TickAsync(T0.AddSeconds(30), default);
        bus.Published.Should().ContainSingle();
        var evt = (ActivePrUpdated)bus.Published[0];
        evt.HeadShaChanged.Should().BeFalse();
        evt.CommentCountChanged.Should().BeTrue();
        evt.NewCommentCount.Should().Be(3);
    }

    [Fact]
    public async Task Does_not_publish_when_snapshot_is_unchanged()
    {
        var (poller, review, bus, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));

        await poller.TickAsync(T0, default);
        await poller.TickAsync(T0.AddSeconds(30), default);
        await poller.TickAsync(T0.AddSeconds(60), default);
        bus.Published.Should().BeEmpty("identical snapshots produce no publish");
    }
}
