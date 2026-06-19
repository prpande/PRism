using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public sealed class AiUsageEndpointTests
{
    [Fact]
    public async Task Get_ai_usage_returns_200_empty_report_when_no_usage_recorded()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("window").GetString().Should().Be("7d"); // default
        body.GetProperty("totals").GetProperty("totalTokens").GetInt64().Should().Be(0);
        body.GetProperty("byFeature").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Get_ai_usage_echoes_validated_window_and_defaults_invalid()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        (await (await client.GetAsync(new Uri("/api/ai/usage?window=24h", UriKind.Relative)))
            .Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("window").GetString().Should().Be("24h");

        (await (await client.GetAsync(new Uri("/api/ai/usage?window=bogus", UriKind.Relative)))
            .Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("window").GetString().Should().Be("7d"); // invalid → default
    }

    [Fact]
    public async Task Get_ai_usage_is_not_gated_on_ai_mode_off()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK); // 200, NOT 204 — past usage shows even when AI off
    }

    [Fact]
    public async Task Get_ai_usage_requires_session_auth()
    {
        using var factory = new PRismWebApplicationFactory();
        // No session token → exercises the global SessionTokenMiddleware. Use the factory's dedicated
        // unauthenticated-client helper (the established pattern; plain CreateClient injects a token).
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
