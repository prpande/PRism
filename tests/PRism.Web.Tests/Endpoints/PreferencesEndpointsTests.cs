using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Note: each test instantiates its own factory rather than using IClassFixture so
// that the IConfigStore singleton (and its on-disk config.json) is fresh per test.
// Sharing the factory across tests caused state leaks: a POST that mutates theme
// would leave the GET defaults assertion failing on subsequent runs.
//
// S6 PR1 (spec § 2.4) widened the response shape: it now nests `ui` / `inbox.sections`
// / `github` blocks. The shape is asserted via JsonElement so a future field add or
// move shows up as a localised assertion failure rather than a record-deserialization
// silent drop.
public class PreferencesEndpointsTests
{
    [Fact]
    public async Task GET_returns_nested_ui_inbox_github_blocks()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();

        var ui = body.GetProperty("ui");
        ui.GetProperty("theme").GetString().Should().Be("system");
        ui.GetProperty("accent").GetString().Should().Be("indigo");
        ui.GetProperty("aiPreview").GetBoolean().Should().BeFalse();
        ui.GetProperty("density").GetString().Should().Be("comfortable");
        ui.GetProperty("contentScale").GetString().Should().Be("m");

        var sections = body.GetProperty("inbox").GetProperty("sections");
        sections.GetProperty("review-requested").GetBoolean().Should().BeTrue();
        sections.GetProperty("awaiting-author").GetBoolean().Should().BeTrue();
        sections.GetProperty("authored-by-me").GetBoolean().Should().BeTrue();
        sections.GetProperty("mentioned").GetBoolean().Should().BeTrue();

        var github = body.GetProperty("github");
        github.GetProperty("host").GetString().Should().Be("https://github.com");
        // ConfigPath derived from ConfigStore._path (= Path.Combine(dataDir, "config.json")).
        github.GetProperty("configPath").GetString().Should().Be(Path.Combine(factory.DataDir, "config.json"));
        // Amendment 2026-05-23 / PR #67 review fix 2026-05-25: assert the FULL path, not just a suffix.
        github.GetProperty("logsPath").GetString().Should().Be(Path.Combine(factory.DataDir, "logs"));
    }

    // Task 6b: the GET response hand-projects InboxSectionsDto, so a config-level
    // addition (RecentlyClosed) is silently omitted until the DTO + projection are
    // widened. Default config has RecentlyClosed = true (AppConfig.cs).
    [Fact]
    public async Task GetPreferences_IncludesRecentlyClosed_DefaultTrue()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
        resp.IsSuccessStatusCode.Should().BeTrue();
        var json = await resp.Content.ReadFromJsonAsync<JsonElement>();

        json.GetProperty("inbox").GetProperty("sections")
            .GetProperty("recently-closed").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task POST_single_field_updates_and_returns_new_nested_shape()
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
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ui").GetProperty("theme").GetString().Should().Be("dark");
    }

    // PR9b-density: density round-trips through the same POST+GET path as theme/accent.
    [Fact]
    public async Task POST_density_updates_and_round_trips()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = JsonContent.Create(new { density = "compact" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ui").GetProperty("density").GetString().Should().Be("compact");

        // Round-trip via a fresh GET to confirm the value persisted across the request boundary.
        var getResp = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
        getResp.IsSuccessStatusCode.Should().BeTrue();
        var getBody = await getResp.Content.ReadFromJsonAsync<JsonElement>();
        getBody.GetProperty("ui").GetProperty("density").GetString().Should().Be("compact");
    }

    [Fact]
    public async Task POST_dotted_inbox_section_updates_and_returns_new_nested_shape()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        // Use a JSON literal because the dotted key is not a valid C# anonymous-property name.
        using var content = new StringContent(
            """{ "inbox.sections.authored-by-me": false }""",
            System.Text.Encoding.UTF8,
            "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = content,
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("inbox").GetProperty("sections").GetProperty("authored-by-me").GetBoolean().Should().BeFalse();
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
}
