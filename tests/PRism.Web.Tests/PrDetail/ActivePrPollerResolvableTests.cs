using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PRism.Core.PrDetail;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.PrDetail;

// Task 4 — ActivePrPoller dual-register smoke test.
// Verifies that ServiceCollectionExtensions registers ActivePrPoller as a true singleton
// (resolvable by concrete type) and that the IHostedService registration resolves to the
// SAME instance. Also verifies IImmediateRefresh resolves to the same singleton.
// Fails fast if a future refactor regresses the AddSingleton+factory pattern.
public class ActivePrPollerResolvableTests
{
    [Fact]
    public void ActivePrPoller_resolves_as_singleton_and_hosted_service()
    {
        using var factory = new PRismWebApplicationFactory();
        var poller = factory.Services.GetRequiredService<ActivePrPoller>();
        poller.Should().NotBeNull();

        var hosted = factory.Services.GetServices<IHostedService>();
        hosted.OfType<ActivePrPoller>().Should().ContainSingle()
            .Which.Should().BeSameAs(poller);
    }

    [Fact]
    public void IImmediateRefresh_resolves_to_same_singleton_as_ActivePrPoller()
    {
        using var factory = new PRismWebApplicationFactory();
        var poller = factory.Services.GetRequiredService<ActivePrPoller>();
        var refresh = factory.Services.GetRequiredService<IImmediateRefresh>();
        refresh.Should().BeSameAs(poller);
    }
}
