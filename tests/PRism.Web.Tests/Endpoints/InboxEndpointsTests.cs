using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class InboxEndpointsTests
{
    private static InboxSnapshot MakeSnapshot(
        IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>>? sections = null,
        IReadOnlyDictionary<string, InboxItemEnrichment>? enrichments = null)
    {
        return new InboxSnapshot(
            sections ?? new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
            enrichments ?? new Dictionary<string, InboxItemEnrichment>(),
            DateTimeOffset.UtcNow);
    }

    private static PrInboxItem MakeItem(string owner = "foo", string repo = "bar", int number = 1) =>
        new(
            new PrReference(owner, repo, number),
            "Test PR",
            "author",
            "foo/bar",
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow,
            1, 0, 10, 5,
            "abc123",
            CiStatus.None,
            null, null);

    [Fact]
    public async Task Get_inbox_cold_start_kicks_refresh_only_once_for_concurrent_requests()
    {
        // Multiple concurrent requests while Current==null must each call WaitForFirstSnapshot,
        // but only one must fire a RefreshAsync (the "cold-start kick").
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = null,
            WaitOverride = (_, _) => Task.FromResult(false), // always times out → 503
        };

        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var tasks = Enumerable.Range(0, 3)
            .Select(_ => client.GetAsync(new Uri("/api/inbox", UriKind.Relative)))
            .ToArray();
        await Task.WhenAll(tasks);

        fakeOrch.RefreshCalls.Should().Be(1,
            "concurrent cold-start requests must kick exactly one refresh, not one per request");
    }

    [Fact]
    public async Task Get_inbox_503_when_no_snapshot_after_timeout()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = null,
            WaitOverride = (_, _) => Task.FromResult(false),
        };

        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/inbox", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        var body = await resp.Content.ReadAsStringAsync();
        body.Should().Contain("/inbox/initializing");
        fakeOrch.RefreshCalls.Should().Be(1, "the GET handler must kick a refresh once on first call before timing out");
    }

    [Fact]
    public async Task Get_inbox_returns_snapshot_when_present()
    {
        var items = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { MakeItem() },
        };
        var enrichments = new Dictionary<string, InboxItemEnrichment>
        {
            ["foo/bar#1"] = new InboxItemEnrichment("foo/bar#1", null, null),
        };
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(items, enrichments),
        };

        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/inbox", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("sections").GetArrayLength().Should().Be(1);
        body.GetProperty("sections")[0].GetProperty("id").GetString().Should().Be("review-requested");
        body.GetProperty("sections")[0].GetProperty("label").GetString().Should().Be("Review requested");
        body.GetProperty("sections")[0].GetProperty("items").GetArrayLength().Should().Be(1);
        body.GetProperty("enrichments").TryGetProperty("foo/bar#1", out _).Should().BeTrue();
        body.GetProperty("lastRefreshedAt").GetDateTimeOffset().Should().BeCloseTo(DateTimeOffset.UtcNow, TimeSpan.FromSeconds(5));
        body.GetProperty("tokenScopeFooterEnabled").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Get_inbox_label_lookup_falls_back_to_id_when_unknown()
    {
        var items = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["unknown-section"] = new[] { MakeItem() },
        };
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(items),
        };

        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/inbox", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var section = body.GetProperty("sections")[0];
        section.GetProperty("id").GetString().Should().Be("unknown-section");
        section.GetProperty("label").GetString().Should().Be("unknown-section");
    }

    [Fact]
    public async Task Get_inbox_token_scope_footer_reflects_config()
    {
        // Default config has ShowHiddenScopeFooter = true; write a config.json that sets it false.
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(),
        };

        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;

        // DataDir is created by ConfigureWebHost (triggered on first client creation), so ensure
        // it exists before writing config.json.
        Directory.CreateDirectory(factory.DataDir);
        await File.WriteAllTextAsync(
            Path.Combine(factory.DataDir, "config.json"),
            """{"inbox":{"showHiddenScopeFooter":false}}""");

        var client = factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/inbox", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("tokenScopeFooterEnabled").GetBoolean().Should().BeFalse();
    }
}
