using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// #740: the PR-detail reload banner announced the user's OWN inline comment post ~30s later.
// The poller nets a self-post (SingleCommentPostedBusEvent) out of the next tick's observed
// inline-comment-count rise before raising a comment frame — see option G, spec § 4-G.
//
// Uses the REAL ReviewEventBus (NOT FakeReviewEventBus, whose Subscribe returns a no-op and
// never invokes handlers — a subscription test against it would pass vacuously). A recorder
// subscribed to the same bus captures every published ActivePrUpdated.
public class ActivePrPollerSelfPostNettingTests
{
    private static readonly DateTimeOffset T0 = new(2026, 7, 10, 0, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Cadence = TimeSpan.FromSeconds(30);

    private static PrReference Pr(int n) => new("o", "r", n);

    // MergeReadiness.Ready held constant keeps the readiness gate quiet after firstPoll, so the
    // comment gate is the only lever these tests exercise.
    private static ActivePrPollSnapshot Snap(int commentCount, string headSha = "h1") =>
        new(headSha, "b", "UNKNOWN", PrState.Open, commentCount, 0, MergeReadiness.Ready, IsDraft: false);

    private static (ActivePrPoller poller, ActivePrSubscriberRegistry registry,
        FakeActivePrBatchReader batch, ReviewEventBus bus, List<ActivePrUpdated> recorded) NewPoller()
    {
        var registry = new ActivePrSubscriberRegistry();
        var batch = new FakeActivePrBatchReader();
        var bus = new ReviewEventBus();
        var recorded = new List<ActivePrUpdated>();
        bus.Subscribe<ActivePrUpdated>(recorded.Add);
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), batch, bus, new ActivePrCache(registry),
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        return (poller, registry, batch, bus, recorded);
    }

    // The #740 regression: a self-post that lands between two ticks must not banner.
    [Fact]
    public async Task SelfPost_between_ticks_does_not_raise_a_comment_frame()
    {
        var (poller, registry, batch, bus, recorded) = NewPoller();
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snap(commentCount: 2));
        await poller.TickAsync(T0, CancellationToken.None);   // firstPoll — seeds the baseline
        recorded.Clear();

        // PRism posts one inline comment: the write path publishes this on the bus.
        bus.Publish(new SingleCommentPostedBusEvent(pr, ReviewCommentId: 123));

        batch.SetSnapshot(pr, Snap(commentCount: 3));         // GitHub now reflects the self-post
        await poller.TickAsync(T0 + Cadence, CancellationToken.None);

        Assert.DoesNotContain(recorded, e => e.CommentCountChanged);
    }

    // #740's hard constraint: an external comment in the SAME poll window as a self-post must
    // still banner. The self-post is netted; the teammate's comment is not.
    [Fact]
    public async Task Teammate_comment_in_the_same_window_still_banners()
    {
        var (poller, registry, batch, bus, recorded) = NewPoller();
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snap(commentCount: 2));
        await poller.TickAsync(T0, CancellationToken.None);   // firstPoll — seeds the baseline
        recorded.Clear();

        bus.Publish(new SingleCommentPostedBusEvent(pr, ReviewCommentId: 123));  // one self-post
        batch.SetSnapshot(pr, Snap(commentCount: 4));         // self-post + one teammate comment
        await poller.TickAsync(T0 + Cadence, CancellationToken.None);

        var evt = Assert.Single(recorded);
        Assert.True(evt.CommentCountChanged);
        Assert.Equal(1, evt.CommentCountDelta);               // teammate announced, self-post netted
    }

    // Fail-open: a self-post GitHub's count never reflects must not swallow a genuine later rise.
    // The credit ages out after SelfPostCreditTtlTicks quiet ticks.
    [Fact]
    public async Task Unreconciled_credit_expires_and_a_later_rise_still_banners()
    {
        var (poller, registry, batch, bus, recorded) = NewPoller();
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snap(commentCount: 2));
        await poller.TickAsync(T0, CancellationToken.None);   // firstPoll — seeds the baseline
        recorded.Clear();

        bus.Publish(new SingleCommentPostedBusEvent(pr, ReviewCommentId: 123)); // never reflected

        var t = T0 + Cadence;
        for (var i = 0; i < 2; i++) { await poller.TickAsync(t, CancellationToken.None); t += Cadence; }
        Assert.Empty(recorded);                               // quiet ticks raise nothing; credit ages out

        batch.SetSnapshot(pr, Snap(commentCount: 3));         // a genuine foreign comment, post-expiry
        await poller.TickAsync(t, CancellationToken.None);

        var evt = Assert.Single(recorded);
        Assert.True(evt.CommentCountChanged);
        Assert.Equal(1, evt.CommentCountDelta);               // the stale credit did not swallow it
    }

    // A credit created before a PR's first poll (subscribe→post→firstPoll race) is folded into the
    // baseline; firstPoll must clear it so it cannot later consume a foreign rise.
    [Fact]
    public async Task FirstPoll_clears_a_pre_baseline_credit_so_a_later_foreign_rise_banners()
    {
        var (poller, registry, batch, bus, recorded) = NewPoller();
        var pr = Pr(1);
        registry.Add("sub1", pr);

        bus.Publish(new SingleCommentPostedBusEvent(pr, ReviewCommentId: 123)); // credited pre-baseline

        batch.SetSnapshot(pr, Snap(commentCount: 3));         // firstPoll baseline already includes it
        await poller.TickAsync(T0, CancellationToken.None);
        recorded.Clear();

        batch.SetSnapshot(pr, Snap(commentCount: 4));         // a foreign comment arrives
        await poller.TickAsync(T0 + Cadence, CancellationToken.None);

        var evt = Assert.Single(recorded);
        Assert.True(evt.CommentCountChanged);
        Assert.Equal(1, evt.CommentCountDelta);               // the orphan credit was cleared at baseline
    }

    // A deletion (negative rise) is not a self-post and passes through unnetted — existing behavior.
    [Fact]
    public async Task Comment_deletion_still_publishes_a_negative_delta()
    {
        var (poller, registry, batch, _, recorded) = NewPoller();
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snap(commentCount: 3));
        await poller.TickAsync(T0, CancellationToken.None);   // firstPoll — seeds the baseline
        recorded.Clear();

        batch.SetSnapshot(pr, Snap(commentCount: 2));         // a comment was deleted
        await poller.TickAsync(T0 + Cadence, CancellationToken.None);

        var evt = Assert.Single(recorded);
        Assert.True(evt.CommentCountChanged);
        Assert.Equal(-1, evt.CommentCountDelta);
    }

    // Baseline: an unchanged tick raises no comment frame at all.
    [Fact]
    public async Task Quiet_tick_raises_no_comment_frame()
    {
        var (poller, registry, batch, _, recorded) = NewPoller();
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snap(commentCount: 2));
        await poller.TickAsync(T0, CancellationToken.None);   // firstPoll — seeds the baseline
        recorded.Clear();

        await poller.TickAsync(T0 + Cadence, CancellationToken.None); // nothing changed
        Assert.Empty(recorded);
    }
}
