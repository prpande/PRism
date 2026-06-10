using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Ai;
using PRism.Core.PrDetail;
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
//
// D111: The /ai/summary endpoint now checks IActivePrCache.IsSubscribed before resolving
// the seam. Tests that expect a 200 (placeholder body) must inject AllSubscribedActivePrCache
// so the gate does not short-circuit to 204.
public class AiEndpointsTests
{
    [Fact]
    public async Task Get_ai_summary_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        // AI now defaults ON (Preview); set OFF explicitly to exercise the Noop → 204 path.
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_summary_returns_200_with_placeholder_body_when_aiPreview_is_on()
    {
        using var baseFactory = new PRismWebApplicationFactory();
        // D111: inject AllSubscribedActivePrCache so the subscriber gate passes and the
        // placeholder seam is reached.
        using var factory = baseFactory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new AllSubscribedActivePrCache());
        }));
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        // WithWebHostBuilder returns a vanilla WebApplicationFactory; CreateClient() does not
        // auto-inject the session token the way PRismWebApplicationFactory.ConfigureClient does.
        // Mirror the PRismWebApplicationFactory pattern: read the token and inject it manually.
        var token = factory.Services.GetRequiredService<PRism.Web.Middleware.SessionTokenProvider>().Current;
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-PRism-Session", token);
        client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin)) client.DefaultRequestHeaders.Add("Origin", origin);

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
        body.GetProperty("category").GetString().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Get_ai_summary_serializes_camelCase_properties()
    {
        using var baseFactory = new PRismWebApplicationFactory();
        // D111: inject AllSubscribedActivePrCache so the subscriber gate passes and the
        // placeholder seam is reached.
        using var factory = baseFactory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new AllSubscribedActivePrCache());
        }));
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        // Same session-token injection as above.
        var token = factory.Services.GetRequiredService<PRism.Web.Middleware.SessionTokenProvider>().Current;
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-PRism-Session", token);
        client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin)) client.DefaultRequestHeaders.Add("Origin", origin);

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
