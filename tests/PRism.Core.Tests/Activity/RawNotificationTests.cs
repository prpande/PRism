using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class RawNotificationTests
{
    [Fact]
    public void RawNotification_carries_pr_fields()
    {
        var n = new RawNotification("acme/api", "review_requested", 1842, "PR #1842",
            "https://api.github.com/repos/acme/api/pulls/1842", DateTimeOffset.UnixEpoch);
        n.Repo.Should().Be("acme/api");
        n.Reason.Should().Be("review_requested");
        n.PrNumber.Should().Be(1842);
    }

    [Fact]
    public void NotificationsResult_carries_degraded()
        => new NotificationsResult([], Degraded: true).Degraded.Should().BeTrue();

    [Fact]
    public void WatchedReposResult_carries_degraded()
        => new WatchedReposResult([], Degraded: true).Degraded.Should().BeTrue();
}
