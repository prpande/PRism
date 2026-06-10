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
        IReadOnlyDictionary<string, InboxItemEnrichment>? enrichments = null,
        DateTimeOffset? refreshedAt = null,
        bool ciProbeComplete = true)
    {
        return new InboxSnapshot(
            sections ?? new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
            enrichments ?? new Dictionary<string, InboxItemEnrichment>(),
            refreshedAt ?? DateTimeOffset.UtcNow,
            ciProbeComplete);
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
        // Pin the snapshot's refresh time to a known instant so the assertion
        // verifies the endpoint round-trips the stored value exactly, rather than
        // comparing two independent wall-clock reads — the latter races and trips
        // BeCloseTo(now, 5s) on a loaded runner (#153).
        var refreshedAt = DateTimeOffset.UtcNow;
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(items, enrichments, refreshedAt),
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
        body.GetProperty("lastRefreshedAt").GetDateTimeOffset().Should().Be(refreshedAt);
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
    public async Task Sections_serialize_in_canonical_order_regardless_of_snapshot_order()
    {
        // Seed snapshot with sections inserted OUT of canonical order to prove
        // the endpoint re-orders them before serialization.
        var items = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["mentioned"]         = new[] { MakeItem() },
            ["review-requested"]  = new[] { MakeItem() },
            ["recently-closed"]   = new[] { MakeItem() },
            ["authored-by-me"]    = new[] { MakeItem() },
            ["awaiting-author"]   = new[] { MakeItem() },
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
        var ids = body.GetProperty("sections").EnumerateArray()
            .Select(s => s.GetProperty("id").GetString())
            .ToList();
        ids.Should().Equal("review-requested", "awaiting-author", "authored-by-me", "mentioned", "recently-closed");
    }

    [Fact]
    public async Task Awaiting_author_label_is_needs_re_review()
    {
        var items = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["awaiting-author"] = new[] { MakeItem() },
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
        var label = body.GetProperty("sections").EnumerateArray().First().GetProperty("label").GetString();
        label.Should().Be("Needs re-review");
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

    [Fact]
    public async Task Get_inbox_ciProbeComplete_false_is_round_tripped()
    {
        // MakeSnapshot with default ciProbeComplete=true is exercised by Get_inbox_returns_snapshot_when_present
        // (tokenScopeFooterEnabled=true there; ciProbeComplete was not checked, but the ctor default covers it).
        // This test pins the false branch: a snapshot whose CI probe has not yet completed must
        // surface ciProbeComplete=false in the serialized response body.
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(ciProbeComplete: false),
        };

        using var factory = new PRismWebApplicationFactory();
        factory.FakeOrchestrator = fakeOrch;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/inbox", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ciProbeComplete").GetBoolean().Should().BeFalse();
    }
}
