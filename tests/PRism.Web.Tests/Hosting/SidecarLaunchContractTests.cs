using System.Net;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Hosting;

/// <summary>
/// Pins the launch-gate contract the Electron desktop shell depends on: GET /api/health
/// MUST be auth-exempt (the shell health-polls it before any session exists) and MUST
/// carry the bound port + dataDir. HealthEndpointsTests covers the happy shape; this
/// test exists under a shell-framed name so a future change that adds auth to /api/health
/// fails as "broke the desktop shell launch gate," not just "health test broke."
/// </summary>
public class SidecarLaunchContractTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public SidecarLaunchContractTests(PRismWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task HealthEndpoint_IsReachableWithoutSession_AndReportsPort()
    {
        // A bare client — no prism-session cookie, no X-PRism-Session header. The shell
        // hits /api/health during bootstrap before any session is minted, so it must pass.
        var client = _factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/health", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync();
        Assert.Contains("\"port\"", body, StringComparison.Ordinal);
        Assert.Contains("\"dataDir\"", body, StringComparison.Ordinal);
    }
}
