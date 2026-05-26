using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Inbox;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Inbox;

// S6 PR2 Task 2.4 — the /api/auth/replace endpoint injects the concrete InboxPoller
// type so it can call RequestImmediateRefresh(). This test fails fast if a future
// refactor regresses the AddSingleton<InboxPoller> + AddHostedService factory pair
// in PRism.Core.ServiceCollectionExtensions.
public class InboxPollerResolvableTests
{
    [Fact]
    public void InboxPoller_IsResolvable_AsConcreteType()
    {
        using var factory = new PRismWebApplicationFactory();
        var poller = factory.Services.GetRequiredService<InboxPoller>();
        poller.Should().NotBeNull();
        var act = () => poller.RequestImmediateRefresh();
        act.Should().NotThrow();
    }
}
