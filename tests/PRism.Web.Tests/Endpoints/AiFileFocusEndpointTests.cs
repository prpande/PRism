using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4. The /ai/file-focus endpoint mirrors /ai/summary's
// seam-resolve-and-map pattern: Noop seam → empty list → 204; Placeholder
// seam → canned data → 200. No per-endpoint IsSubscribed check — D111
// defers that to the real-AI seam-swap moment.
public class AiFileFocusEndpointTests
{
    [Fact]
    public async Task Get_ai_file_focus_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_file_focus_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("path").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("level").GetString().Should().BeOneOf("high", "medium", "low");
    }

    [Fact]
    public async Task Get_ai_file_focus_returns_401_without_session_token()
    {
        // Spec § 5.4: per-route spot-check that SessionTokenMiddleware covers
        // the new endpoint. Catches accidental middleware exemption widening
        // (a la /api/health) for the /ai/* family.
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
