using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Capabilities;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #283: each test owns its factory (no shared IClassFixture) so it can set AiPreviewState
// without leaking across the class — the default is now AiPreview ON, so the OFF case must
// flip it explicitly. Capabilities are uniformly AllOn/AllOff from AiPreviewState.IsOn.
public class CapabilitiesEndpointsTests
{
    [Fact]
    public async Task Returns_AllOn_under_default_aiPreview()
    {
        using var factory = new PRismWebApplicationFactory();
        // Default state: AiPreviewState.IsOn = true (#283 default-on).
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.Ai.Summary.Should().BeTrue();
        resp.Ai.HunkAnnotations.Should().BeTrue();
    }

    [Fact]
    public async Task Returns_AllOff_when_aiPreview_is_false()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = false;
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.Ai.Summary.Should().BeFalse();
        resp.Ai.HunkAnnotations.Should().BeFalse();
    }

    public sealed record CapabilitiesResponse(AiCapabilities Ai);
}
