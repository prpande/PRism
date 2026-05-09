using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 7.3. The Overview tab's AiSummaryCard fetches its placeholder content
// from the backend so the architecture stays aligned with v2 (real AI swaps in
// at the same endpoint). PoC behavior:
//   - aiPreview off → seam selector returns NoopPrSummarizer; SummarizeAsync returns null;
//     endpoint returns 204 No Content.
//   - aiPreview on  → seam selector returns PlaceholderPrSummarizer; canned PrSummary
//     comes back; endpoint returns 200 with { body, category }.
public class AiEndpointsTests
{
    [Fact]
    public async Task Get_ai_summary_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        // Default state: AiPreviewState.IsOn = false → NoopPrSummarizer.
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_summary_returns_200_with_placeholder_body_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
        body.GetProperty("category").GetString().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Get_ai_summary_serializes_camelCase_properties()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await resp.Content.ReadAsStringAsync();
        // Property names ride the host's JsonSerializerOptions (camelCase default).
        // Asserting raw JSON catches a regression where this endpoint accidentally
        // bypasses the configured options and ships PascalCase to the wire.
        raw.Should().Contain("\"body\"").And.Contain("\"category\"");
        raw.Should().NotContain("\"Body\"").And.NotContain("\"Category\"");
    }
}
