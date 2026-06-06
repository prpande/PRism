using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Capabilities;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class CapabilitiesEndpointsTests
{
    [Fact]
    public async Task Off_mode_reports_all_false_mode_off_reason_none()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));

        resp!.Ai.Summary.Should().BeFalse();
        resp.Mode.Should().Be("off");
        resp.DisabledReason.Should().Be("none");
    }

    [Fact]
    public async Task Preview_mode_reports_all_true_keeps_ai_envelope()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/capabilities", UriKind.Relative));
        var raw = await resp.Content.ReadAsStringAsync();

        raw.Should().Contain("\"ai\"").And.Contain("\"summary\"");          // FE-compat envelope intact
        raw.Should().Contain("\"mode\":\"preview\"");
        using var doc = JsonDocument.Parse(raw);
        doc.RootElement.GetProperty("ai").GetProperty("summary").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Live_mode_with_unavailable_provider_reports_all_false_and_the_reason()
    {
        using var factory = new PRismWebApplicationFactory
        {
            AvailabilityProbeOverride = new StubAvailabilityProbe(LlmAvailability.Unavailable("cli-not-installed")),
        };
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        var client = factory.CreateClient();

        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));

        resp!.Ai.Summary.Should().BeFalse();
        resp.Mode.Should().Be("live");
        resp.DisabledReason.Should().Be("cli-not-installed");
    }

    public sealed record CapabilitiesResponse(AiCapabilities Ai, string Mode, string DisabledReason);
}
