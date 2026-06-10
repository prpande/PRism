using System;
using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityFeedBuilderTests
{
    private static readonly DateTimeOffset Now = new(2026, 6, 9, 12, 0, 0, TimeSpan.Zero);

    private static RawReceivedEvent Ev(
        string id, string type, string? actor = "alice", string repo = "acme/api",
        string? action = null, int? pr = 7, bool merged = false,
        bool isPrComment = false, int hoursAgo = 1, string? avatar = "https://a/x.png",
        string? title = "T", string? url = "https://github.com/acme/api/pull/7")
        => new(id, type, actor, avatar, repo, action, pr, title, url, merged, isPrComment,
            Now.AddHours(-hoursAgo));

    [Fact]
    public void Maps_review_reviewcomment_issuecomment_pr_lifecycle()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent"),
            Ev("2", "PullRequestReviewCommentEvent"),
            Ev("3", "IssueCommentEvent", isPrComment: true),
            Ev("4", "PullRequestEvent", action: "opened"),
            Ev("5", "PullRequestEvent", action: "reopened"),
            Ev("6", "PullRequestEvent", action: "closed", merged: false),
            Ev("7", "PullRequestEvent", action: "closed", merged: true),
        };

        // Distinct ids + same timestamp ordering preserved via stable sort by ts desc.
        ActivityFeedBuilder.Build(raw, Now).Items.Select(i => i.Verb).Should()
            .BeEquivalentTo(new[]
            {
                ActivityVerb.Reviewed, ActivityVerb.Commented, ActivityVerb.Commented,
                ActivityVerb.Opened, ActivityVerb.Reopened, ActivityVerb.Closed, ActivityVerb.Merged,
            });
    }

    [Fact]
    public void Drops_plain_issue_comment_and_unmapped_types()
    {
        var raw = new[]
        {
            Ev("1", "IssueCommentEvent", isPrComment: false),   // plain issue → drop
            Ev("2", "PushEvent", pr: null),                      // no PR → drop
            Ev("3", "WatchEvent"),                               // unmapped → drop
            Ev("4", "PullRequestReviewEvent"),                   // kept
        };

        ActivityFeedBuilder.Build(raw, Now).Items.Should().ContainSingle()
            .Which.Verb.Should().Be(ActivityVerb.Reviewed);
    }

    [Fact]
    public void Drops_and_counts_recognized_event_missing_actor_or_pr()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent", actor: null),      // recognized but no actor
            Ev("2", "PullRequestReviewEvent", pr: null),         // recognized but no PR
            Ev("3", "PullRequestReviewEvent"),                   // kept
        };

        var result = ActivityFeedBuilder.Build(raw, Now);
        result.Items.Should().ContainSingle();
        result.DroppedRecognized.Should().Be(2);
    }

    [Fact]
    public void Tags_bots_by_suffix_and_allowlist()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent", actor: "mergewatch-playlist[bot]"),
            Ev("2", "PullRequestReviewEvent", actor: "Copilot"),
            Ev("3", "PullRequestReviewEvent", actor: "alice"),
        };

        var byActor = ActivityFeedBuilder.Build(raw, Now).Items
            .ToDictionary(i => i.ActorLogin!, i => i.ActorIsBot);

        byActor["mergewatch-playlist[bot]"].Should().BeTrue();
        byActor["Copilot"].Should().BeTrue();
        byActor["alice"].Should().BeFalse();
    }

    [Fact]
    public void Dedups_reemitted_duplicate_by_event_id_keeping_distinct_ids()
    {
        var raw = new[]
        {
            Ev("dup", "PullRequestReviewEvent", actor: "Copilot", pr: 195, hoursAgo: 1),
            Ev("dup", "PullRequestReviewEvent", actor: "Copilot", pr: 195, hoursAgo: 1), // same id
            Ev("other", "PullRequestReviewEvent", actor: "Copilot", pr: 195, hoursAgo: 5), // distinct id
        };

        // Same id collapses to one; the distinct-id second review by the same
        // actor on the same PR is PRESERVED (it is real, distinct activity).
        ActivityFeedBuilder.Build(raw, Now).Items.Should().HaveCount(2);
    }

    [Fact]
    public void Windows_to_last_24h()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent", hoursAgo: 1),
            Ev("2", "PullRequestReviewEvent", hoursAgo: 25),   // outside 24h
        };

        ActivityFeedBuilder.Build(raw, Now).Items.Should().ContainSingle();
    }

    [Fact]
    public void Sorts_newest_first_and_caps_to_max_raw_items()
    {
        var raw = Enumerable.Range(0, 70)
            .Select(i => Ev(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "PullRequestReviewEvent", pr: i, hoursAgo: i % 23 + 1,
                url: $"https://github.com/acme/api/pull/{i}"))
            .ToArray();

        var items = ActivityFeedBuilder.Build(raw, Now).Items;
        items.Count.Should().Be(ActivityFeedBuilder.MaxRawItems);   // 50, NOT 12 (client caps to 12)
        items.Should().BeInDescendingOrder(i => i.Timestamp);
    }
}

// Phase 2 — multi-source merge engine. Own fixture helpers (Ev/Nf/Build) with the
// full-overload signature; kept in a separate class so they don't collide with the
// P1 single-source Ev() above.
public sealed class ActivityFeedBuilderMergeTests
{
    private const string Host = "https://github.com";  // full URL incl. scheme — matches config.Current.Github.Host shape; URLs build as $"{Host}/..."

    // NOTE: HtmlUrl is REQUIRED — builder drops events with null/empty HtmlUrl. ActorLogin is REQUIRED too.
    // Use NAMED arguments — the real record order is (Id, Type, ActorLogin, ActorAvatarUrl, Repo, Action,
    // PrNumber, Title, HtmlUrl, Merged, IsPullRequestComment, CreatedAt) (verified in RawReceivedEvent.cs).
    // Positional construction silently mis-slots fields (action→ActorLogin) and drops every event; named
    // args make a future reorder a compile error instead of an empty-feed merge "bug".
    private static RawReceivedEvent Ev(string id, string actor, string type, string action,
        string repo, int pr, DateTimeOffset ts, bool merged = false) =>
        new(Id: id, Type: type, ActorLogin: actor, ActorAvatarUrl: $"https://avatars/{actor}",
            Repo: repo, Action: action, PrNumber: pr, Title: $"PR #{pr}",
            HtmlUrl: $"https://github.com/{repo}/pull/{pr}", Merged: merged,
            IsPullRequestComment: type == "IssueCommentEvent", CreatedAt: ts);

    private static RawNotification Nf(string reason, string repo, int pr, DateTimeOffset ts) =>
        new(repo, reason, pr, $"PR #{pr}", $"https://api.github.com/repos/{repo}/pulls/{pr}", ts);

    private static ActivityBuildResult Build(RawReceivedEvent[] ev, RawNotification[] nf, string[] watched, DateTimeOffset now, string[]? extraBots = null)
        => ActivityFeedBuilder.Build(ev, nf, watched, Host, extraBots ?? [], now);

    [Fact] // non-you-relevant duplicate notification folds into matching event, keeping actor
    public void Comment_notification_merges_into_matching_event_keeping_actor()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ev = Ev("1", "noah.s", "PullRequestReviewCommentEvent", "", "acme/api", 10, now.AddMinutes(-5));
        var nf = Nf("comment", "acme/api", 10, now.AddMinutes(-4));        // → Commented, matches verb
        var item = Build([ev], [nf], [], now).Items.Should().ContainSingle().Subject;
        item.ActorLogin.Should().Be("noah.s");
        item.Source.Should().Be(ActivitySource.ReceivedEvent);
    }

    [Fact]
    public void Distinct_actors_same_pr_verb_stay_separate()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var a = Ev("1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
        var b = Ev("2", "jules.t", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-6));
        Build([a, b], [], [], now).Items.Should().HaveCount(2);
    }

    [Fact] // GENUINE 3-way: comment notification + two distinct comment actors, SAME (Repo,Pr,Commented) group
    public void Three_way_comment_notification_merges_into_most_recent_event()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var older = Ev("1", "noah.s", "PullRequestReviewCommentEvent", "", "acme/api", 10, now.AddMinutes(-9));
        var newer = Ev("2", "jules.t", "PullRequestReviewCommentEvent", "", "acme/api", 10, now.AddMinutes(-5));
        var nf = Nf("comment", "acme/api", 10, now.AddMinutes(-4));        // Commented, same group as both events
        var r = Build([older, newer], [nf], [], now);
        r.Items.Should().HaveCount(2);                                     // notif folds in, both actors survive
        r.Items.Select(i => i.ActorLogin).Should().BeEquivalentTo(["noah.s", "jules.t"]);
    }

    [Fact] // you-relevant notification is always its own actorless row (verb has no event counterpart)
    public void Review_requested_notification_stays_actorless_row()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ev = Ev("1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
        var nf = Nf("review_requested", "acme/api", 10, now.AddMinutes(-4));
        var r = Build([ev], [nf], [], now);
        r.Items.Should().HaveCount(2);                                     // separate verbs → separate rows
        r.Items.Should().ContainSingle(i => i.Verb == ActivityVerb.ReviewRequested && i.ActorLogin == null);
    }

    [Fact] // DUPLICATE NOTIFICATIONS collapse (GitHub re-emits same repo/reason/PR)
    public void Duplicate_notifications_same_key_collapse_to_one()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var n1 = Nf("comment", "acme/api", 10, now.AddMinutes(-6));
        var n2 = Nf("comment", "acme/api", 10, now.AddMinutes(-4));        // same (Repo,Pr,Commented), no events
        Build([], [n1, n2], [], now).Items.Should().ContainSingle();
    }

    [Fact] // subscribed→Other never merges with a concrete-verb event for the same PR
    public void Subscribed_notification_does_not_merge_with_closed_event()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ev = Ev("1", "noah.s", "PullRequestEvent", "closed", "acme/api", 10, now.AddMinutes(-5));
        var nf = Nf("subscribed", "acme/api", 10, now.AddMinutes(-4));     // → Other (different verb)
        Build([ev], [nf], [], now).Items.Should().HaveCount(2);
    }

    [Fact] // SLOT RESERVATION at the visible 12 with notifications NEWER than events (the flood)
    public void Slot_reservation_keeps_min_event_rows_in_visible_window()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var events = Enumerable.Range(1, 5)                                // events are OLDER
            .Select(i => Ev(i.ToString(System.Globalization.CultureInfo.InvariantCulture), $"u{i}", "PullRequestReviewEvent", "", "acme/api", i, now.AddMinutes(-30 - i)))
            .ToList();
        var notifs = Enumerable.Range(100, 40)                             // fresh flood, you-relevant so no merge
            .Select(i => Nf("review_requested", "acme/api", i, now.AddMinutes(-1)))
            .ToList();
        var r = Build([.. events], [.. notifs], [], now);
        r.Items.Take(ActivityFeedBuilder.MaxActivityItems)
            .Count(i => i.Source == ActivitySource.ReceivedEvent)
            .Should().BeGreaterThanOrEqualTo(ActivityFeedBuilder.MinEventSlots);  // >=4 events in the visible 12
    }

    [Fact] // BOT events must NOT consume reserved slots (client strips bots before slicing)
    public void Slot_reservation_reserves_non_bot_events_under_bot_and_notification_pressure()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var humans = Enumerable.Range(1, 5)                                // OLDER human events
            .Select(i => Ev(i.ToString(System.Globalization.CultureInfo.InvariantCulture), $"u{i}", "PullRequestReviewEvent", "", "acme/api", i, now.AddMinutes(-30 - i)))
            .ToList();
        var bots = Enumerable.Range(50, 6)                                 // fresh BOT events (Copilot-style)
            .Select(i => Ev(i.ToString(System.Globalization.CultureInfo.InvariantCulture), "Copilot", "PullRequestReviewEvent", "", "acme/api", i, now.AddMinutes(-2)))
            .ToList();
        var notifs = Enumerable.Range(100, 40)                             // fresh you-relevant flood
            .Select(i => Nf("review_requested", "acme/api", i, now.AddMinutes(-1)))
            .ToList();
        var r = Build([.. humans, .. bots], [.. notifs], [], now);
        // simulate the client's pre-slice bot filter, then take the visible window
        r.Items.Where(i => !i.ActorIsBot).Take(ActivityFeedBuilder.MaxActivityItems)
            .Count(i => i.Source == ActivitySource.ReceivedEvent)
            .Should().BeGreaterThanOrEqualTo(ActivityFeedBuilder.MinEventSlots);  // >=4 HUMAN events survive client filter
    }

    [Fact] // EDGE: fewer than MinEventSlots non-bot events in a >12 feed — no crash, no over-take, all events kept
    public void Reservation_keeps_all_non_bot_events_when_fewer_than_min_slots()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var events = new[]                                                  // only 2 non-bot events (< MinEventSlots=4)
        {
            Ev("e1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 1, now.AddMinutes(-30)),
            Ev("e2", "jules.t", "PullRequestReviewEvent", "", "acme/api", 2, now.AddMinutes(-31)),
        };
        var notifs = Enumerable.Range(100, 40)                             // fresh you-relevant flood → >12 total
            .Select(i => Nf("review_requested", "acme/api", i, now.AddMinutes(-1)))
            .ToList();

        var r = Build([.. events], [.. notifs], [], now);

        // No over-take past the raw ceiling, and BOTH (the few) non-bot events are present.
        r.Items.Count.Should().BeLessThanOrEqualTo(ActivityFeedBuilder.MaxRawItems);
        r.Items.Count(i => i.Source == ActivitySource.ReceivedEvent).Should().Be(2);
        r.Items.Should().Contain(i => i.ActorLogin == "noah.s");
        r.Items.Should().Contain(i => i.ActorLogin == "jules.t");
    }

    [Fact] // GUARD the ReferenceEqualityComparer in ReserveEventSlots' taken-set:
    // two distinct-id events with identical actor/verb/repo/pr/title/url/timestamp map to
    // VALUE-EQUAL ActivityItems (ActivityItem has no Id field, so the differing event id
    // disappears in the projection). BuildEventItems keeps both (id-keyed dedup) and MergeFeeds
    // AddRanges both (same group, no per-actor dedup), so two value-equal instances reach the
    // sort. A structural taken-set would conflate them and drop one; reference equality keeps
    // both. They are OLDER than the flood so both must be promoted through the reserve loop.
    public void Value_equal_items_from_distinct_event_ids_both_survive_reservation()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ts = now.AddMinutes(-30);                                       // identical ts, older than the flood

        // Same actor/verb/repo/pr → Ev produces identical avatar/title/url too; only the event
        // id differs, and the id is NOT a field on ActivityItem → the two projections are value-equal.
        var a = Ev("id-a", "noah.s", "PullRequestReviewEvent", "", "acme/api", 1, ts);
        var b = Ev("id-b", "noah.s", "PullRequestReviewEvent", "", "acme/api", 1, ts);

        var notifs = Enumerable.Range(100, 40)                             // fresh flood pushes a/b below the head
            .Select(i => Nf("review_requested", "acme/api", i, now.AddMinutes(-1)))
            .ToList();

        var r = Build([a, b], [.. notifs], [], now);

        // Both value-equal event items survive ReserveEventSlots' taken-set (count == 2).
        // With a structural set the second would be conflated with the first and dropped → count 1.
        r.Items.Count(i => i.Source == ActivitySource.ReceivedEvent && i.ActorLogin == "noah.s")
            .Should().Be(2);
    }

    [Fact] // ADDITIVE bot config: a configured extra bot login is flagged ActorIsBot
    public void Configured_extra_bot_login_is_flagged_as_bot()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ev = Ev("1", "acme-ci", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
        var item = Build([ev], [], [], now, extraBots: ["acme-ci"]).Items.Should().ContainSingle().Subject;
        item.ActorIsBot.Should().BeTrue();
    }

    [Fact] // built-in baseline always applies, even with empty config
    public void Builtin_copilot_flagged_with_empty_extra_bots()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ev = Ev("1", "Copilot", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
        Build([ev], [], [], now).Items.Should().ContainSingle().Subject.ActorIsBot.Should().BeTrue();
    }

    [Fact] // a human login not in any list is NOT a bot (extra-bots matching is exact, case-insensitive)
    public void Human_login_not_in_lists_is_not_bot()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var ev = Ev("1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
        Build([ev], [], [], now, extraBots: ["acme-ci"]).Items.Should().ContainSingle().Subject.ActorIsBot.Should().BeFalse();
    }

    [Fact] // notification items are NEVER bot-flagged (no actor), even with adversarial extra-bots config
    public void Notification_item_is_never_bot_flagged()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var nf = Nf("review_requested", "acme/api", 10, now.AddMinutes(-3));   // actorless, you-relevant → own row
        var item = Build([], [nf], [], now, extraBots: ["review_requested", ""]).Items.Should().ContainSingle().Subject;
        item.ActorLogin.Should().BeNull();
        item.ActorIsBot.Should().BeFalse();   // must survive the default !actorIsBot filter
    }

    [Fact]
    public void Watching_count_pre_cap_orders_by_count_then_name_with_idle_padding()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var events = new[]
        {
            Ev("1","a","PullRequestReviewEvent","","acme/api",1, now.AddMinutes(-1)),
            Ev("2","b","PullRequestReviewEvent","","acme/api",2, now.AddMinutes(-2)),
            Ev("3","c","PullRequestReviewEvent","","acme/pos",3, now.AddMinutes(-3)),
        };
        var r = Build(events, [], ["acme/api","acme/pos","acme/idle"], now);
        r.Watching.Select(w => w.Repo).Should().Equal("acme/api", "acme/pos", "acme/idle");
        r.Watching.Single(w => w.Repo == "acme/api").Count.Should().Be(2);
        r.Watching.Single(w => w.Repo == "acme/idle").Count.Should().Be(0);
        r.Watching.Single(w => w.Repo == "acme/api").Url.Should().Be("https://github.com/acme/api");
    }

    [Fact] // notification-only repo still shows Count>0 (not idle)
    public void Watching_counts_notification_only_repo()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var nf = Nf("comment", "acme/api", 10, now.AddMinutes(-3));        // no events
        Build([], [nf], ["acme/api"], now).Watching.Single().Count.Should().Be(1);
    }

    [Fact]
    public void Watching_pads_to_max_rows_cap()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var watched = Enumerable.Range(1, 20).Select(i => $"acme/r{i}").ToList();
        Build([], [], [.. watched], now).Watching.Should().HaveCount(8);  // MaxWatchingRows
    }

    [Fact]
    public void Notifications_outside_window_filtered()
    {
        var now = DateTimeOffset.UnixEpoch.AddHours(48);
        var stale = Nf("comment", "acme/api", 10, now.AddHours(-30));
        Build([], [stale], [], now).Items.Should().BeEmpty();
    }
}
