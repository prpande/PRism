using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests;

public class ProgramSmokeTests
{
    [Fact]
    public async Task Application_boots_and_serves_health_and_capabilities_and_preferences_and_auth_state()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        (await client.GetAsync(new Uri("/api/health", UriKind.Relative))).IsSuccessStatusCode.Should().BeTrue();
        (await client.GetAsync(new Uri("/api/capabilities", UriKind.Relative))).IsSuccessStatusCode.Should().BeTrue();
        (await client.GetAsync(new Uri("/api/preferences", UriKind.Relative))).IsSuccessStatusCode.Should().BeTrue();
        (await client.GetAsync(new Uri("/api/auth/state", UriKind.Relative))).IsSuccessStatusCode.Should().BeTrue();
    }
}
