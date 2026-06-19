using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
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
        // AI defaults ON: default ui.ai.mode = Preview → derived aiPreview = true.
        ui.GetProperty("aiPreview").GetBoolean().Should().BeTrue();
        ui.GetProperty("aiMode").GetString().Should().Be("preview");
        ui.GetProperty("density").GetString().Should().Be("comfortable");
        ui.GetProperty("contentScale").GetString().Should().Be("m");

        var sections = body.GetProperty("inbox").GetProperty("sections");
        sections.GetProperty("review-requested").GetBoolean().Should().BeTrue();
        sections.GetProperty("awaiting-author").GetBoolean().Should().BeTrue();
        sections.GetProperty("authored-by-me").GetBoolean().Should().BeTrue();
        sections.GetProperty("mentioned").GetBoolean().Should().BeTrue();
        // #283 the activity rail is decoupled from AI onto this dedicated flag, default OFF.
        body.GetProperty("inbox").GetProperty("showActivityRail").GetBoolean().Should().BeFalse();

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

    // Task 11: lock the aiPreview ↔ ui.ai.mode round-trip (FE-compat contract).
    // POST { "aiPreview": true } must drive mode=Preview; GET must expose both the
    // legacy aiPreview bool and the new aiMode string; AiModeState must follow synchronously.
    [Fact]
    public async Task POST_legacy_aiPreview_true_sets_mode_preview_and_GET_reflects_both()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var post = await client.PostAsync(new Uri("/api/preferences", UriKind.Relative),
            JsonContent.Create(new { aiPreview = true }));
        post.IsSuccessStatusCode.Should().BeTrue();

        var prefs = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
        var body = await prefs.Content.ReadFromJsonAsync<JsonElement>();
        var ui = body.GetProperty("ui");
        ui.GetProperty("aiPreview").GetBoolean().Should().BeTrue();   // FE still reads this
        ui.GetProperty("aiMode").GetString().Should().Be("preview");  // new field for PR3

        // The runtime AiModeState followed the POST synchronously.
        factory.Services.GetRequiredService<AiModeState>().Mode.Should().Be(AiMode.Preview);
    }

    [Fact]
    public async Task POST_ui_ai_mode_live_sets_mode_and_derives_aiPreview_true()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        // dotted/kebab key isn't a valid C# identifier → raw StringContent (existing idiom).
        var post = await client.PostAsync(new Uri("/api/preferences", UriKind.Relative),
            new StringContent("""{ "ui.ai.mode": "live" }""", Encoding.UTF8, "application/json"));
        post.IsSuccessStatusCode.Should().BeTrue();

        var prefs = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
        var body = await prefs.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ui").GetProperty("aiMode").GetString().Should().Be("live");
        body.GetProperty("ui").GetProperty("aiPreview").GetBoolean().Should().BeTrue();
    }

    // #275: GET /api/preferences surfaces inbox.sectionOrder (defaults to canonical),
    // and POST round-trips a valid permutation.
    [Fact]
    public async Task GET_inbox_sectionOrder_defaults_and_POST_round_trips()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        var initial = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));
        initial.GetProperty("inbox").GetProperty("sectionOrder").GetString()
            .Should().Be("review-requested,awaiting-author,authored-by-me,mentioned");

        using var content = new StringContent(
            """{ "inbox.sectionOrder": "mentioned,authored-by-me,review-requested,awaiting-author" }""",
            System.Text.Encoding.UTF8,
            "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = content,
        };
        req.Headers.Add("Origin", origin);
        var post = await client.SendAsync(req);
        post.StatusCode.Should().Be(HttpStatusCode.OK);

        var after = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));
        after.GetProperty("inbox").GetProperty("sectionOrder").GetString()
            .Should().Be("mentioned,authored-by-me,review-requested,awaiting-author");
    }

    // #283: inbox.showActivityRail surfaces in GET (default false) and round-trips through POST.
    [Fact]
    public async Task GET_inbox_showActivityRail_defaults_false_and_POST_round_trips()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        var initial = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));
        initial.GetProperty("inbox").GetProperty("showActivityRail").GetBoolean().Should().BeFalse();

        using var content = new StringContent(
            """{ "inbox.showActivityRail": true }""",
            System.Text.Encoding.UTF8,
            "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = content,
        };
        req.Headers.Add("Origin", origin);
        var post = await client.SendAsync(req);
        post.StatusCode.Should().Be(HttpStatusCode.OK);
        var postBody = await post.Content.ReadFromJsonAsync<JsonElement>();
        postBody.GetProperty("inbox").GetProperty("showActivityRail").GetBoolean().Should().BeTrue();

        var after = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));
        after.GetProperty("inbox").GetProperty("showActivityRail").GetBoolean().Should().BeTrue();
    }

    // #219: inbox.groupByRepo surfaces in GET (default true) and round-trips through POST.
    [Fact]
    public async Task GET_inbox_groupByRepo_defaults_true_and_POST_round_trips()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        var initial = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));
        initial.GetProperty("inbox").GetProperty("groupByRepo").GetBoolean().Should().BeTrue();

        using var content = new StringContent(
            """{ "inbox.groupByRepo": false }""",
            System.Text.Encoding.UTF8,
            "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = content,
        };
        req.Headers.Add("Origin", origin);
        var post = await client.SendAsync(req);
        post.StatusCode.Should().Be(HttpStatusCode.OK);
        var postBody = await post.Content.ReadFromJsonAsync<JsonElement>();
        postBody.GetProperty("inbox").GetProperty("groupByRepo").GetBoolean().Should().BeFalse();

        var after = await client.GetFromJsonAsync<JsonElement>(new Uri("/api/preferences", UriKind.Relative));
        after.GetProperty("inbox").GetProperty("groupByRepo").GetBoolean().Should().BeFalse();
    }

    // Task 6: /api/preferences POST with malformed JSON body must return 400 "invalid-json"
    // (before the fix it returned 500 because JsonDocument.ParseAsync threw unhandled).
    [Fact]
    public async Task Preferences_malformed_body_returns_400_invalid_json()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("{ not json", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("error").GetString().Should().Be("invalid-json");
    }

    // Task 6 guard: a well-formed-but-non-object body (a JSON array) must keep returning the
    // pre-existing 400 "body must be a JSON object" envelope after the HttpJson routing change —
    // i.e. the NotObject branch was preserved, not collapsed into the new invalid-json branch.
    [Fact]
    public async Task Preferences_non_object_body_returns_400_not_object()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("[1,2,3]", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("error").GetString().Should().Be("body must be a JSON object");
    }

    // #536: GET /api/preferences must project all nine feature flags onto ui.features, default true.
    [Fact]
    public async Task Get_preferences_projects_all_nine_features_default_true()
    {
        using var factory = new PRismWebApplicationFactory();   // the real factory name in this file (capital R)
        var client = factory.CreateClient();

        var body = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
        var features = body.GetProperty("ui").GetProperty("features");

        features.GetProperty("summary").GetBoolean().Should().BeTrue();
        features.GetProperty("fileFocus").GetBoolean().Should().BeTrue();
        features.GetProperty("inboxRanking").GetBoolean().Should().BeTrue();
        features.EnumerateObject().Count().Should().Be(9);
    }

    // #536: POST ui.ai.features.summary=false round-trips through GET ui.features.summary=false.
    [Fact]
    public async Task Post_feature_off_round_trips_through_get()
    {
        using var factory = new PRismWebApplicationFactory();   // same factory as the sibling test (capital R)
        var client = factory.CreateClient();

        var resp = await client.PostAsJsonAsync("/api/preferences",
            new Dictionary<string, object> { ["ui.ai.features.summary"] = false });
        resp.EnsureSuccessStatusCode();

        var body = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
        body.GetProperty("ui").GetProperty("features").GetProperty("summary").GetBoolean().Should().BeFalse();
    }
}
