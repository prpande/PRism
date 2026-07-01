using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// Task 3: ActivePrPoller adaptive fast-retry for derived UNKNOWN (MergeReadiness.None).
// Proves the per-PR budget arithmetic by driving TickAsync directly; ExecuteAsync adaptive
// wake (Task 4) is not involved here — PeekState assertions are the sole verification surface.
public class ActivePrPollerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 28, 0, 0, 0, TimeSpan.Zero);

    private static PrReference Pr(int n) => new("o", "r", n);

    private static (ActivePrPoller poller, ActivePrSubscriberRegistry registry, FakeActivePrBatchReader batch) NewPoller()
    {
        var registry = new ActivePrSubscriberRegistry();
        var batch = new FakeActivePrBatchReader();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), batch, bus, cache,
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        return (poller, registry, batch);
    }

    private static ActivePrPollSnapshot MakeSnapshot(
        MergeReadiness readiness,
        bool isDraft,
        string headSha = "h1",
        PrState prState = PrState.Open,
        int issueComments = 0,
        int? approvals = null,
        int? changesRequested = null,
        string[]? awaiting = null) =>
        new(headSha, "b", "UNKNOWN", prState, 0, 0, readiness,
            IsDraft: isDraft,
            Approvals: approvals,
            ChangesRequested: changesRequested,
            AwaitingReviewers: awaiting?.Select(l => new Reviewer(l)).ToArray(),
            IssueCommentCount: issueComments);

    [Fact]
    public async Task UnknownReadiness_schedules_fast_retry_and_survives_success_reset()
    {
        var (poller, registry, batch) = NewPoller();
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeSnapshot(readiness: MergeReadiness.None, isDraft: false));
        await poller.TickAsync(T0, CancellationToken.None);

        var state = poller.PeekState(Pr(1));                       // add an internal test accessor
        Assert.Equal(T0.AddSeconds(1), state.NextRetryAt);         // scheduled, NOT nulled by the :233 reset
        Assert.Equal(1, state.FastRetryCount);
    }

    [Theory]
    [InlineData(MergeReadiness.Ready, false)]   // definitive -> no fast retry
    [InlineData(MergeReadiness.None, true)]     // draft None -> no fast retry
    public async Task FastRetry_skips_definitive_and_draft(MergeReadiness readiness, bool isDraft)
    {
        var (poller, registry, batch) = NewPoller();
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeSnapshot(readiness: readiness, isDraft: isDraft));
        await poller.TickAsync(T0, CancellationToken.None);
        Assert.Null(poller.PeekState(Pr(1)).NextRetryAt);
    }

    [Fact]
    public async Task FastRetry_stops_after_cap_but_still_polls_normally()
    {
        var (poller, registry, batch) = NewPoller();
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeSnapshot(readiness: MergeReadiness.None, isDraft: false));
        var t = T0;
        for (var i = 0; i < 6; i++) { await poller.TickAsync(t, CancellationToken.None); t = t.AddSeconds(60); }
        var state = poller.PeekState(Pr(1));
        Assert.Equal(5, state.FastRetryCount);                    // capped
        Assert.Null(state.NextRetryAt);                           // no more fast schedule; reverts to cadence
    }

    [Fact]
    public async Task FastRetry_head_change_after_cap_resets_budget_and_rearms()
    {
        // After exhausting the burst budget (FastRetryCount == FastRetryCap = 5), a tick whose
        // snapshot carries a CHANGED HeadSha must reset FastRetryCount to 0 and re-arm
        // NextRetryAt to now + FastBackoff(0) = now + 1s.
        var (poller, registry, batch) = NewPoller();
        registry.Add("sub1", Pr(1));
        batch.SetSnapshot(Pr(1), MakeSnapshot(readiness: MergeReadiness.None, isDraft: false, headSha: "h1"));

        // Six ticks at 60s intervals exhaust the 5-attempt cap and leave NextRetryAt null.
        var t = T0;
        for (var i = 0; i < 6; i++) { await poller.TickAsync(t, CancellationToken.None); t = t.AddSeconds(60); }
        Assert.Equal(5, poller.PeekState(Pr(1)).FastRetryCount);
        Assert.Null(poller.PeekState(Pr(1)).NextRetryAt);

        // A new commit with a different HeadSha arrives. The headChanged local (computed before
        // LastHeadSha is overwritten) triggers a budget reset, and wantsFastRetry re-arms at 1s.
        batch.SetSnapshot(Pr(1), MakeSnapshot(readiness: MergeReadiness.None, isDraft: false, headSha: "h2"));
        var rearmAt = t; // T0 + 360s
        await poller.TickAsync(rearmAt, CancellationToken.None);

        var state = poller.PeekState(Pr(1));
        Assert.Equal(rearmAt.AddSeconds(1), state.NextRetryAt);   // re-armed at FastBackoff(0) = 1s
        Assert.Equal(1, state.FastRetryCount);                    // was reset to 0, then incremented after scheduling
    }

    // #620: a new ROOT PR comment (comments{ totalCount }) is the feed's primary content, but it
    // bumps neither HeadSha, CommentCount (inline-review-thread comments only), PrState, nor
    // MergeReadiness. Without a dedicated gate term the poller would publish nothing and the
    // live timeline would never refresh on a plain root comment.
    [Fact]
    public async Task Publishes_when_only_root_comments_change()
    {
        var registry = new ActivePrSubscriberRegistry();
        var batch = new FakeActivePrBatchReader();
        var bus = new FakeReviewEventBus();
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), batch, bus, new ActivePrCache(registry),
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, MakeSnapshot(readiness: MergeReadiness.Ready, isDraft: false, issueComments: 2));
        await poller.TickAsync(T0, CancellationToken.None);          // firstPoll — seeds state, emits
        bus.Clear();

        batch.SetSnapshot(pr, MakeSnapshot(readiness: MergeReadiness.Ready, isDraft: false, issueComments: 3));
        await poller.TickAsync(T0.AddSeconds(30), CancellationToken.None); // only the root-comment count changed

        Assert.Single(bus.Published.OfType<ActivePrUpdated>());
    }

    // #620: an approval/changes-request/review-request delta rides the frame's Approvals /
    // ChangesRequested / AwaitingReviewers fields but never triggered the gate on its own — a
    // reviewer approving with no other change (head/inline-comment/state/readiness) published
    // nothing today.
    [Fact]
    public async Task Publishes_when_only_approvals_change()
    {
        var registry = new ActivePrSubscriberRegistry();
        var batch = new FakeActivePrBatchReader();
        var bus = new FakeReviewEventBus();
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), batch, bus, new ActivePrCache(registry),
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        var pr = Pr(1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, MakeSnapshot(readiness: MergeReadiness.Ready, isDraft: false,
            approvals: 0, changesRequested: 0, awaiting: new[] { "lee" }));
        await poller.TickAsync(T0, CancellationToken.None);
        bus.Clear();

        batch.SetSnapshot(pr, MakeSnapshot(readiness: MergeReadiness.Ready, isDraft: false,
            approvals: 1, changesRequested: 0, awaiting: Array.Empty<string>()));
        await poller.TickAsync(T0.AddSeconds(30), CancellationToken.None); // only approvals changed

        var evt = Assert.Single(bus.Published.OfType<ActivePrUpdated>());
        Assert.Equal(1, evt.Approvals);
    }
}
