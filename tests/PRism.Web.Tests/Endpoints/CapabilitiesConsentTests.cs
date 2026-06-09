using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

/// <summary>
/// Verifies that consent flows through /api/capabilities correctly:
/// Live + provider available + no consent → summary=false + disabledReason="consent-required".
/// Live + provider available + consented → summary depends on registered seams (empty in test host,
/// so still false, but disabledReason="none").
/// </summary>
public class CapabilitiesConsentTests
{
    [Fact]
    public async Task Live_available_no_consent_reports_consent_required()
    {
        using var factory = new PRismWebApplicationFactory
        {
            AvailabilityProbeOverride = new StubAvailabilityProbe(LlmAvailability.Ok),
        };
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        // Consent state defaults to AiConsentConfig.None — do NOT set it, simulating no consent.
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/capabilities", UriKind.Relative));

        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var raw = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        doc.RootElement.GetProperty("ai").GetProperty("summary").GetBoolean().Should().BeFalse();
        doc.RootElement.GetProperty("mode").GetString().Should().Be("live");
        doc.RootElement.GetProperty("disabledReason").GetString().Should().Be("consent-required");
    }

    [Fact]
    public async Task Live_available_consented_reports_reason_none()
    {
        using var factory = new PRismWebApplicationFactory
        {
            AvailabilityProbeOverride = new StubAvailabilityProbe(LlmAvailability.Ok),
        };
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        // Record consent for Claude / current disclosure version.
        factory.Services.GetRequiredService<AiConsentState>()
            .Set(new AiConsentConfig(AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/capabilities", UriKind.Relative));

        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var raw = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        doc.RootElement.GetProperty("disabledReason").GetString().Should().Be("none");
        // No real live seam is registered in the test host (P0 empty dict), so summary is still false —
        // but the reason is "none" not "consent-required".
        doc.RootElement.GetProperty("ai").GetProperty("summary").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Live_probe_unavailable_and_unconsented_reports_probe_reason_not_consent_required()
    {
        // Probe-unavailable reason MUST win over consent-required (precedence §T6).
        using var factory = new PRismWebApplicationFactory
        {
            AvailabilityProbeOverride = new StubAvailabilityProbe(LlmAvailability.Unavailable("cli-not-installed")),
        };
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
        // No consent set — default None.
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/capabilities", UriKind.Relative));

        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        var raw = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        doc.RootElement.GetProperty("disabledReason").GetString().Should().Be("cli-not-installed");
    }
}
