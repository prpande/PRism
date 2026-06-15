using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #496: /api/preferences accepts the two AI numeric knobs (ui.ai.providerTimeoutSeconds,
// ui.ai.hunkAnnotationCap) via the POST Number arm, and GET exposes both — clamped for
// display so the shown value equals the effective value even after a hand-edited config.json.
//
// Mirrors PreferencesEndpointsTests: a fresh PRismWebApplicationFactory per test (so the
// IConfigStore singleton + on-disk config.json don't leak state) with an Origin header on
// POST. There is no authenticated-client requirement on this endpoint.
public class PreferencesAiNumericTests
{
    [Fact]
    public async Task Post_integer_timeout_round_trips_and_is_echoed()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("""{ "ui.ai.providerTimeoutSeconds": 300 }""", Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var json = await resp.Content.ReadFromJsonAsync<JsonElement>();
        json.GetProperty("ui").GetProperty("providerTimeoutSeconds").GetInt32().Should().Be(300);
    }

    [Fact]
    public async Task Post_non_integer_number_is_rejected_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("""{ "ui.ai.providerTimeoutSeconds": 3.5 }""", Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Post_number_outside_int32_range_is_rejected_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("""{ "ui.ai.providerTimeoutSeconds": 99999999999 }""", Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Get_exposes_both_ai_numeric_values()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var json = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));

        var ui = json.GetProperty("ui");
        ui.GetProperty("providerTimeoutSeconds").ValueKind.Should().Be(JsonValueKind.Number);
        ui.GetProperty("hunkAnnotationCap").ValueKind.Should().Be(JsonValueKind.Number);
    }
}
