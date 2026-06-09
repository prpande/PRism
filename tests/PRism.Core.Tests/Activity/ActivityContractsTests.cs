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
            new ActivityDegradation(ReceivedEvents: false));

        resp.Items.Should().ContainSingle().Which.PrNumber.Should().Be(7);
        resp.Degraded.ReceivedEvents.Should().BeFalse();
    }
}
