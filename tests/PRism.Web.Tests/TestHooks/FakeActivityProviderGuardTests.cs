using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Activity;

namespace PRism.Web.Tests.TestHooks;

// Guards that FakeActivityProvider is never injected in Production.
// The positive side (FakeActivityProvider served under Test+PRISM_E2E_FAKE_REVIEW=1)
// is exercised by the frontend Playwright suite; this xUnit test only guards the
// critical negative: the real ActivityProvider resolves in Production.
public sealed class FakeActivityProviderGuardTests
{
    [Fact]
    public void Production_resolves_real_ActivityProvider_not_fake()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            b.UseEnvironment("Production"));
        using var scope = factory.Services.CreateScope();
        var provider = scope.ServiceProvider.GetRequiredService<IActivityProvider>();
        provider.Should().BeOfType<ActivityProvider>();
    }
}
