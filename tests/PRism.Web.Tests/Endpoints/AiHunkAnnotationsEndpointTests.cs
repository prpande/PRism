using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4. The /ai/hunk-annotations endpoint surfaces ALL
// annotations for the PR in one fetch — calls the per-hunk seam method
// with empty filePath + 0 hunkIndex sentinels; the placeholder ignores
// them (D109 documents this seam-vs-endpoint divergence).
public class AiHunkAnnotationsEndpointTests
{
    [Fact]
    public async Task Get_ai_hunk_annotations_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_hunk_annotations_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("path").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("hunkIndex").GetInt32().Should().BeGreaterOrEqualTo(0);
        first.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("tone").GetString().Should().BeOneOf("calm", "heads-up", "concern");
    }

    [Fact]
    public async Task Get_ai_hunk_annotations_returns_401_without_session_token()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
