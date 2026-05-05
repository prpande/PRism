using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Note: each test instantiates its own factory rather than using IClassFixture so
// that the IConfigStore singleton (and its on-disk config.json) is fresh per test.
// Sharing the factory across tests caused state leaks: a POST that mutates theme
// would leave the GET defaults assertion failing on subsequent runs.
public class PreferencesEndpointsTests
{
    [Fact]
    public async Task GET_returns_full_ui_block()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<UiBlock>(new Uri("/api/preferences", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.Theme.Should().Be("system");
        resp.Accent.Should().Be("indigo");
        resp.AiPreview.Should().BeFalse();
    }

    [Fact]
    public async Task POST_single_field_updates_and_returns_full_block()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = JsonContent.Create(new { theme = "dark" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<UiBlock>();
        body!.Theme.Should().Be("dark");
    }

    [Fact]
    public async Task POST_multi_field_returns_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = JsonContent.Create(new { theme = "dark", accent = "amber" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    public sealed record UiBlock(string Theme, string Accent, bool AiPreview);
}
