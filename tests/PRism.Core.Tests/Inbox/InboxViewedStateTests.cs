using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public class InboxViewedStateTests
{
    private static AppState StateWithSession(string key, ReviewSessionState session)
    {
        var sessions = new Dictionary<string, ReviewSessionState> { [key] = session };
        return AppState.Default.WithDefaultReviews(
            AppState.Default.Reviews with { Sessions = sessions });
    }

    private static ReviewSessionState Session(
        Dictionary<string, TabStamp> tabStamps, string? lastSeenCommentId = null) =>
        new(tabStamps, lastSeenCommentId, null, null,
            new Dictionary<string, string>(),
            new List<DraftComment>(), new List<DraftReply>(),
            null, DraftVerdictStatus.Draft);

    private static PrInboxItem Item(PrReference reference, string headSha,
        string? lastViewedHeadSha = null, long? lastSeenCommentId = null) =>
        new(reference, "T", "a", "acme/api",
            System.DateTimeOffset.UtcNow, System.DateTimeOffset.UtcNow,
            1, 0, 1, 0, headSha, CiStatus.None, lastViewedHeadSha, lastSeenCommentId);

    [Fact]
    public void Project_returns_most_recent_tab_stamp_head_by_stamped_at()
    {
        var reference = new PrReference("acme", "api", 1);
        var session = Session(new Dictionary<string, TabStamp>
        {
            ["older"] = new TabStamp("OLD", new System.DateTime(2026, 6, 1, 0, 0, 0, System.DateTimeKind.Utc)),
            ["newer"] = new TabStamp("NEW", new System.DateTime(2026, 6, 2, 0, 0, 0, System.DateTimeKind.Utc)),
        }, lastSeenCommentId: "42");
        var state = StateWithSession(reference.ToString(), session);

        var (lastViewedHeadSha, lastSeenCommentId) = InboxViewedState.Project(reference, state);

        lastViewedHeadSha.Should().Be("NEW");
        lastSeenCommentId.Should().Be(42);
    }

    [Fact]
    public void Project_returns_nulls_when_no_session()
    {
        var (lastViewedHeadSha, lastSeenCommentId) =
            InboxViewedState.Project(new PrReference("acme", "api", 999), AppState.Default);

        lastViewedHeadSha.Should().BeNull();
        lastSeenCommentId.Should().BeNull();
    }

    [Fact]
    public void ApplyViewedState_overwrites_a_stale_baked_value_with_the_live_stamp()
    {
        var reference = new PrReference("acme", "api", 1);
        var snapshot = new InboxSnapshot(
            new Dictionary<string, IReadOnlyList<PrInboxItem>>
            {
                ["review-requested"] = new[] { Item(reference, headSha: "HEAD", lastViewedHeadSha: "STALE") },
            },
            new Dictionary<string, InboxItemEnrichment>(),
            System.DateTimeOffset.UtcNow);
        var state = StateWithSession(reference.ToString(), Session(new Dictionary<string, TabStamp>
        {
            ["t1"] = new TabStamp("HEAD", System.DateTime.UtcNow),
        }));

        var result = InboxViewedState.ApplyViewedState(snapshot, state);

        result.Sections["review-requested"][0].LastViewedHeadSha.Should().Be("HEAD");
    }

    [Fact]
    public void ApplyViewedState_leaves_unviewed_item_null_and_preserves_other_fields()
    {
        var reference = new PrReference("acme", "api", 2);
        var item = Item(reference, headSha: "HEAD", lastViewedHeadSha: null);
        var snapshot = new InboxSnapshot(
            new Dictionary<string, IReadOnlyList<PrInboxItem>> { ["review-requested"] = new[] { item } },
            new Dictionary<string, InboxItemEnrichment>(),
            System.DateTimeOffset.UtcNow);

        var result = InboxViewedState.ApplyViewedState(snapshot, AppState.Default);

        var overlaid = result.Sections["review-requested"][0];
        overlaid.LastViewedHeadSha.Should().BeNull();
        overlaid.HeadSha.Should().Be("HEAD");
        overlaid.Reference.Should().Be(reference);
    }

    [Fact]
    public void ApplyViewedState_reprojects_every_section_independently()
    {
        var viewed = new PrReference("acme", "api", 1);   // has a live stamp at HEAD
        var unviewed = new PrReference("acme", "api", 2);  // no session → stays unread
        var snapshot = new InboxSnapshot(
            new Dictionary<string, IReadOnlyList<PrInboxItem>>
            {
                ["review-requested"] = new[] { Item(viewed, headSha: "HEAD", lastViewedHeadSha: "STALE") },
                ["authored-by-me"] = new[] { Item(unviewed, headSha: "HEAD2", lastViewedHeadSha: null) },
            },
            new Dictionary<string, InboxItemEnrichment>(),
            System.DateTimeOffset.UtcNow);
        var state = StateWithSession(viewed.ToString(), Session(new Dictionary<string, TabStamp>
        {
            ["t1"] = new TabStamp("HEAD", System.DateTime.UtcNow),
        }));

        var result = InboxViewedState.ApplyViewedState(snapshot, state);

        result.Sections.Keys.Should().BeEquivalentTo(new[] { "review-requested", "authored-by-me" });
        result.Sections["review-requested"][0].LastViewedHeadSha.Should().Be("HEAD");   // overlaid from live stamp
        result.Sections["authored-by-me"][0].LastViewedHeadSha.Should().BeNull();        // no session → unread preserved
    }
}
