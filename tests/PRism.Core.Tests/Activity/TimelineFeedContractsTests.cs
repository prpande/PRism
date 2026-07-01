using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class TimelineFeedContractsTests
{
    [Fact]
    public void TimelinePage_exposes_events_cursor_and_hasolder()
    {
        var actor = new TimelineActorRef("alice", "https://a/alice", IsBot: false);
        var evt = new TimelineEvent(
            Id: "c1", Verb: ActivityVerb.Approved, Actor: actor,
            Timestamp: DateTimeOffset.UnixEpoch, Body: null, CommitCount: null, Subject: null);
        var page = new TimelinePage(new[] { evt }, OlderCursor: "cur", HasOlder: true);

        page.Events.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Approved);
        page.OlderCursor.Should().Be("cur");
        page.HasOlder.Should().BeTrue();
        page.Degraded.Should().BeFalse();   // default: a real page is not degraded
    }
}
