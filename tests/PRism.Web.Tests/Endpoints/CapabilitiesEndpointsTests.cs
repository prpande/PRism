using FluentAssertions;
using PRism.AI.Contracts.Capabilities;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class CapabilitiesEndpointsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public CapabilitiesEndpointsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Returns_AllOff_when_aiPreview_is_false()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.Ai.Summary.Should().BeFalse();
        resp.Ai.HunkAnnotations.Should().BeFalse();
    }

    public sealed record CapabilitiesResponse(AiCapabilities Ai);
}
