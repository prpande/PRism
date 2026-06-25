using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// Migrated to the batched active-poll path (#598 Slice B). The poller now issues ONE
// PollBatchAsync per tick across every subscribed PR. Backoff is whole-tick (a rate-limit /
// transport / poison-payload throw backs off ALL candidates and publishes nothing — last-known
// retained); a per-alias drop keeps last-known for the dropped ref and publishes nothing for it.
public class ActivePrPollerBackoffTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 7, 0, 0, 0, TimeSpan.Zero);

    private static (ActivePrPoller poller, FakeActivePrBatchReader batch, FakeReviewEventBus bus, ActivePrSubscriberRegistry registry, IActivePrCache cache) Build()
    {
        var registry = new ActivePrSubscriberRegistry();
        var batch = new FakeActivePrBatchReader();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var poller = new ActivePrPoller(
            registry, new FakePollerReviewService(), batch, bus, cache,
            NullLogger<ActivePrPoller>.Instance,
            new FakeHostEnvironment("Production"));
        return (poller, batch, bus, registry, cache);
    }

    private static ActivePrPollSnapshot Snapshot(string headSha = "h1", string baseSha = "b1", int commentCount = 0, PrState prState = PrState.Open) =>
        new(headSha, baseSha, "MERGEABLE", prState, commentCount, 0);

    [Fact]
    public async Task Whole_tick_rate_limit_backs_off_all_refs_then_resumes_after_backoff_elapses()
    {
        var (poller, batch, _, registry, _) = Build();
        var prA = new PrReference("o", "r", 1);
        var prB = new PrReference("o", "r", 2);
        registry.Add("sub1", prA);
        registry.Add("sub1", prB);

        // Tick 1: rate-limited → both refs backoff 60s, no batch returns.
        batch.SetThrows(new RateLimitExceededException("rate", null));
        await poller.TickAsync(T0, default);
        batch.BatchCallCount.Should().Be(1);

        // Tick 2 at T0+1 (within 60s backoff): both refs skipped → no batch call issued.
        await poller.TickAsync(T0.AddSeconds(1), default);
        batch.BatchCallCount.Should().Be(1, "all candidates are in backoff, so no batch call is issued");

        // Tick 3 at T0+120 (past 60s backoff): refs eligible again → batch call resumes.
        batch.ClearThrow();
        batch.SetSnapshot(prA, Snapshot());
        batch.SetSnapshot(prB, Snapshot());
        await poller.TickAsync(T0.AddSeconds(120), default);
        batch.BatchCallCount.Should().Be(2, "backoff elapsed, so the batch poll runs again");
    }

    [Fact]
    public async Task Backoff_resets_after_successful_tick()
    {
        var (poller, batch, _, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        // Tick 1: error → backoff 60s.
        batch.SetThrows(new RateLimitExceededException("rate", null));
        await poller.TickAsync(T0, default);
        batch.BatchCallCount.Should().Be(1);

        // Tick at T0+120 (past 60s backoff): success → ConsecutiveErrors=0, NextRetryAt=null.
        batch.ClearThrow();
        batch.SetSnapshot(pr, Snapshot());
        await poller.TickAsync(T0.AddSeconds(120), default);
        batch.BatchCallCount.Should().Be(2);

        // New error: ConsecutiveErrors should reset to 1 (not climb to 2). Backoff = 60s.
        batch.SetThrows(new RateLimitExceededException("rate", null));
        await poller.TickAsync(T0.AddSeconds(121), default);
        batch.BatchCallCount.Should().Be(3);

        // Confirm backoff was 60s (reset worked) by polling at T0+182. If reset failed and
        // ConsecutiveErrors had climbed to 3, backoff would be 240s and the tick would be skipped.
        batch.ClearThrow();
        batch.SetSnapshot(pr, Snapshot());
        await poller.TickAsync(T0.AddSeconds(182), default);
        batch.BatchCallCount.Should().Be(4, "backoff reset to 60s after a successful tick, so the poll runs again at T0+182");
    }

    [Fact]
    public async Task Per_alias_drop_keeps_last_known_for_dropped_ref_while_other_ref_publishes()
    {
        var (poller, batch, bus, registry, _) = Build();
        var prA = new PrReference("o", "r", 1);
        var prB = new PrReference("o", "r", 2);
        registry.Add("sub1", prA);
        registry.Add("sub1", prB);

        // PR A absent from the returned map (per-alias null); PR B present.
        batch.DropRef(prA);
        batch.SetSnapshot(prB, Snapshot());

        await poller.TickAsync(T0, default);

        batch.BatchCallCount.Should().Be(1, "one batch call serves all candidates");
        bus.Published.OfType<ActivePrUpdated>().Should().ContainSingle("only the returned ref publishes; the dropped ref keeps last-known");
        ((ActivePrUpdated)bus.Published[0]).PrRef.Should().Be(prB);
    }

    [Fact]
    public async Task FirstSuccessfulPoll_PublishesActivePrUpdated_EvenWithoutDeltas()
    {
        // Spec § 5.6 + frontend `useFirstActivePrPollComplete`: the gate hook backing the
        // Mark-all-read button needs the first successful poll for a newly-subscribed PR to
        // surface as a `pr-updated` SSE event. Both delta flags are false on the first poll.
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));

        await poller.TickAsync(T0, default);

        bus.Published.Should().ContainSingle();
        var evt = (ActivePrUpdated)bus.Published[0];
        evt.PrRef.Should().Be(pr);
        evt.HeadShaChanged.Should().BeFalse();
        evt.CommentCountChanged.Should().BeFalse();
        evt.NewHeadSha.Should().BeNull();
        evt.CommentCountDelta.Should().Be(0);
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_when_head_sha_changes()
    {
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snapshot(headSha: "h1"));
        await poller.TickAsync(T0, default);  // first poll publishes a hydration event
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");
        var firstEvt = (ActivePrUpdated)bus.Published[0];
        firstEvt.HeadShaChanged.Should().BeFalse("the first event has no prior state to diff against");

        batch.SetSnapshot(pr, Snapshot(headSha: "h2"));
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
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));
        await poller.TickAsync(T0, default);
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 3));
        await poller.TickAsync(T0.AddSeconds(30), default);
        bus.Published.Should().HaveCount(2);
        var deltaEvt = (ActivePrUpdated)bus.Published[1];
        deltaEvt.HeadShaChanged.Should().BeFalse();
        deltaEvt.CommentCountChanged.Should().BeTrue();
        deltaEvt.CommentCountDelta.Should().Be(3);
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_with_IsMerged_on_open_to_merged_transition_even_when_head_and_comments_unchanged()
    {
        // Spec § 5.2.3: a clean merge leaves head-sha and comment-count unchanged. The poller must
        // still emit on the open→merged state transition so the frontend can show the merged banner.
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 5, prState: PrState.Open));
        await poller.TickAsync(T0, default);
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");

        // Same head, same comment count — only the state flips open → merged.
        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 5, prState: PrState.Merged));
        await poller.TickAsync(T0.AddSeconds(30), default);

        bus.Published.Should().HaveCount(2, "the open→merged transition is a change even with identical head/comments");
        var evt = (ActivePrUpdated)bus.Published[1];
        evt.PrRef.Should().Be(pr);
        evt.HeadShaChanged.Should().BeFalse();
        evt.CommentCountChanged.Should().BeFalse();
        evt.IsMerged.Should().BeTrue();
        evt.IsClosed.Should().BeFalse("merged and closed are mutually exclusive on the wire");
    }

    [Fact]
    public async Task Does_not_publish_again_on_steady_state_merged_tick()
    {
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 5, prState: PrState.Open));
        await poller.TickAsync(T0, default);
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 5, prState: PrState.Merged));
        await poller.TickAsync(T0.AddSeconds(30), default);
        bus.Published.Should().HaveCount(2, "the open→merged transition emits exactly one event");

        // Tick 3: same merged snapshot — no head change, no comment change, no state change.
        await poller.TickAsync(T0.AddSeconds(60), default);
        bus.Published.Should().HaveCount(2, "steady-state merged tick must not re-emit");
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_with_IsClosed_on_open_to_closed_transition()
    {
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 5, prState: PrState.Open));
        await poller.TickAsync(T0, default);
        bus.Published.Should().ContainSingle();

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 5, prState: PrState.Closed));
        await poller.TickAsync(T0.AddSeconds(30), default);

        bus.Published.Should().HaveCount(2);
        var evt = (ActivePrUpdated)bus.Published[1];
        evt.IsClosed.Should().BeTrue();
        evt.IsMerged.Should().BeFalse();
    }

    [Fact]
    public async Task Does_not_publish_again_when_snapshot_is_unchanged()
    {
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));

        await poller.TickAsync(T0, default);
        await poller.TickAsync(T0.AddSeconds(30), default);
        await poller.TickAsync(T0.AddSeconds(60), default);
        bus.Published.Should().ContainSingle("the first poll publishes a hydration event; identical subsequent snapshots do not");
    }

    [Fact]
    public async Task Publishes_ActivePrUpdated_when_base_sha_changes_with_unchanged_head()
    {
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        batch.SetSnapshot(pr, Snapshot(headSha: "h1", baseSha: "b1"));
        await poller.TickAsync(T0, default);  // first poll → hydration event, BaseShaChanged false
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");
        ((ActivePrUpdated)bus.Published[0]).BaseShaChanged.Should().BeFalse("no prior base to diff");

        // Base branch advances; head unchanged.
        batch.SetSnapshot(pr, Snapshot(headSha: "h1", baseSha: "b2"));
        await poller.TickAsync(T0.AddSeconds(30), default);

        bus.Published.Should().HaveCount(2, "a same-head base-only move must be published, not swallowed");
        var deltaEvt = (ActivePrUpdated)bus.Published[1];
        deltaEvt.HeadShaChanged.Should().BeFalse();
        deltaEvt.BaseShaChanged.Should().BeTrue();
        deltaEvt.NewBaseSha.Should().Be("b2");
    }

    [Fact]
    public async Task FirstPoll_hydrates_LastBaseSha_without_emitting_BaseShaChanged()
    {
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        batch.SetSnapshot(pr, Snapshot(headSha: "h1", baseSha: "b1"));

        await poller.TickAsync(T0, default);

        bus.Published.Should().ContainSingle();
        ((ActivePrUpdated)bus.Published[0]).BaseShaChanged.Should().BeFalse();
    }

    [Fact]
    public async Task Resubscribe_after_observed_unsubscribe_re_emits_first_poll_for_quiet_pr()
    {
        // Issue #609 — the user-visible defect. Open PR A → close tab (unsubscribe) →
        // reopen the still-quiet PR A (re-subscribe). Because the poller retained _state
        // from the first view, firstPoll was false on re-subscribe and a quiet PR with no
        // head/base/comment/state change emitted nothing — leaving the frontend
        // Mark-all-read gate (useFirstActivePrPollComplete) closed for the process lifetime.
        // Pruning state when a PR loses its last subscriber resets first-poll detection.
        var (poller, batch, bus, registry, _) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        batch.SetSnapshot(pr, Snapshot(headSha: "h1", commentCount: 0));

        await poller.TickAsync(T0, default);                 // first poll → hydration event
        bus.Published.Should().ContainSingle("first poll publishes a hydration event");

        registry.Remove("sub1", pr);                         // last subscriber gone
        await poller.TickAsync(T0.AddSeconds(30), default);  // tick observes zero subscribers → prunes state
        bus.Published.Should().ContainSingle("with no subscribers nothing is polled or published");

        registry.Add("sub2", pr);                            // re-subscribe; PR is still quiet (same head/comments)
        await poller.TickAsync(T0.AddSeconds(60), default);

        bus.Published.Should().HaveCount(2, "re-subscribe after an observed unsubscribe must re-fire the first-poll hydration event");
        var evt = (ActivePrUpdated)bus.Published[1];
        evt.HeadShaChanged.Should().BeFalse("a re-fired hydration event has no prior state to diff against");
        evt.CommentCountChanged.Should().BeFalse();
    }

    [Fact]
    public async Task State_is_pruned_for_prs_that_lose_all_subscribers()
    {
        // Issue #609 — the resource leak. _state accumulated one entry per distinct PR ever
        // subscribed in the process lifetime; entries were never reclaimed. Pruning on tick
        // bounds _state to the set of currently-subscribed PRs.
        var (poller, batch, _, registry, _) = Build();
        var prA = new PrReference("o", "r", 1);
        var prB = new PrReference("o", "r", 2);
        registry.Add("sub1", prA);
        registry.Add("sub1", prB);
        batch.SetSnapshot(prA, Snapshot());
        batch.SetSnapshot(prB, Snapshot());

        await poller.TickAsync(T0, default);
        poller.TrackedStateCount.Should().Be(2, "both subscribed PRs are tracked after a poll");

        registry.RemoveSubscriber("sub1");                   // both PRs lose their only subscriber
        await poller.TickAsync(T0.AddSeconds(30), default);

        poller.TrackedStateCount.Should().Be(0, "state for PRs with no active subscribers is reclaimed each tick");
    }
}
