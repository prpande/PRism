using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class HealthEndpointsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public HealthEndpointsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Get_health_returns_port_version_dataDir()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetFromJsonAsync<JsonObject>(new Uri("/api/health", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.ContainsKey("port").Should().BeTrue();
        resp.ContainsKey("version").Should().BeTrue();
        (resp.ContainsKey("dataDir") || resp.ContainsKey("data-dir")).Should().BeTrue();
    }
}
