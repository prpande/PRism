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

        var verbs = ActivityFeedBuilder.Build(raw, Now).Items
            .OrderBy(i => i.Timestamp).Select(i => i.Verb).ToArray();

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
