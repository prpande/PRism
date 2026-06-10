using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityContractsTests
{
    [Fact]
    public void ActivityResponse_holds_items_and_degradation()
    {
        var item = new ActivityItem("alice", null, false, ActivityVerb.Reviewed,
            "acme/api", 7, "Fix it", "https://github.com/acme/api/pull/7",
            System.DateTimeOffset.UnixEpoch, ActivitySource.ReceivedEvent);
        var resp = new ActivityResponse([item], System.DateTimeOffset.UnixEpoch,
            new ActivityDegradation(ReceivedEvents: false, Notifications: false, Watching: false), []);

        resp.Items.Should().ContainSingle().Which.PrNumber.Should().Be(7);
        resp.Degraded.ReceivedEvents.Should().BeFalse();
    }

    [Fact]
    public void ActivitySource_has_Notification()
        => Enum.IsDefined(ActivitySource.Notification).Should().BeTrue();

    [Fact]
    public void ActivityVerb_has_ReviewRequested_and_Mentioned()
    {
        Enum.IsDefined(ActivityVerb.ReviewRequested).Should().BeTrue();
        Enum.IsDefined(ActivityVerb.Mentioned).Should().BeTrue();
    }

    [Fact]
    public void ActivityDegradation_carries_three_flags()
    {
        var d = new ActivityDegradation(ReceivedEvents: true, Notifications: false, Watching: true);
        d.ReceivedEvents.Should().BeTrue();
        d.Notifications.Should().BeFalse();
        d.Watching.Should().BeTrue();
    }

    [Fact]
    public void ActivityResponse_carries_watching()
    {
        var w = new WatchedRepoActivity("acme/api", 3, "https://github.com/acme/api");
        var r = new ActivityResponse([], DateTimeOffset.UnixEpoch,
            new ActivityDegradation(false, false, false), [w]);
        r.Watching.Should().ContainSingle().Which.Repo.Should().Be("acme/api");
    }
}
