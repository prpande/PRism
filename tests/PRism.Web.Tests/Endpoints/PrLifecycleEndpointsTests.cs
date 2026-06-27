using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using FluentAssertions;

using PRism.Core;
using PRism.Core.Events;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Task 7 — POST /api/pr/{owner}/{repo}/{number}/{close|reopen|ready-for-review|convert-to-draft}
//
// Security gates verified here:
//  - CSRF custom-header gate (X-PRism-Tab-Id missing → 422 "tab-id-missing")
//  - Subscribe gate (not subscribed → 403 "unauthorized" via RequireSubscribed.Check)
//
// Error-mapping coverage verified here:
//  - TokenCannotWrite  → 403 "token-cannot-write"
//  - RepoRuleBlocked   → 403 "repo-rule-blocked"   (distinct FE copy; separate test per plan review)
//  - ReopenNotPossible → 422 "reopen-not-possible"
//
// Success path verified:
//  - 200 + PrLifecycleChanged bus event published
//
// Snapshot eviction (Task 5) and SSE fan-out (Task 6) have their own dedicated subscriber tests;
// this class asserts the publish that triggers them, not the full downstream chain.
public class PrLifecycleEndpointsTests
{
    // Builds a POST request with a valid X-PRism-Tab-Id on the message itself. Note: when using
    // ctx.CreateClient() (default tabId="tab-test"), the client also has a default X-PRism-Tab-Id
    // header. Having two values for the same header is harmless here — the endpoint takes
    // FirstOrDefault() and either value passes the allowlist regex.
    private static HttpRequestMessage Post(string action) =>
        new(HttpMethod.Post, $"/api/pr/o/r/1/{action}") { Headers = { { "X-PRism-Tab-Id", "tab-123" } } };

    [Fact]
    public async Task Close_success_returns_200_and_publishes_PrLifecycleChanged()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Ok;
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Writer.Calls.Should().ContainSingle().Which.Should().Be("close");
        await TestPoll.UntilAsync(
            () => ctx.Bus.Published.OfType<PrLifecycleChanged>().Any(),
            TimeSpan.FromSeconds(5),
            "PrLifecycleChanged should publish");
    }

    [Fact]
    public async Task Close_token_cannot_write_returns_403_with_code()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(PrLifecycleErrorCode.TokenCannotWrite);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("code").GetString().Should().Be("token-cannot-write");
        ctx.Bus.Published.OfType<PrLifecycleChanged>().Should().BeEmpty();
    }

    // Plan ce-doc-review (scope): the spec lists repo-rule-blocked as a DISTINCT 403 case
    // (different FE copy — does NOT advise changing the PAT). Exercise the MapError branch.
    [Fact]
    public async Task Close_repo_rule_blocked_returns_403_with_distinct_code()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(PrLifecycleErrorCode.RepoRuleBlocked);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("repo-rule-blocked");
    }

    [Fact]
    public async Task Reopen_not_possible_returns_422_with_code()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(PrLifecycleErrorCode.ReopenNotPossible);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("reopen"));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("reopen-not-possible");
    }

    [Fact]
    public async Task Missing_tab_id_header_is_rejected()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        // Plan ce-doc-review round 2 (feasibility): CreateClient() DEFAULTS X-PRism-Tab-Id to
        // "tab-test" so a plain client would send a valid id and get 200. Pass tabId: null to
        // genuinely omit the header (the SubmitEndpointsTestContext pattern).
        using var client = ctx.CreateClient(tabId: null);

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/1/close", UriKind.Relative), content: null); // genuinely no X-PRism-Tab-Id

        // 422 "tab-id-missing" — mirrors submit endpoint's tab-id gate status (confirmed Step 0).
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        ctx.Writer.Calls.Should().BeEmpty();
    }

    // Plan ce-doc-review (security): assert the ACTUAL status + code (403 + "unauthorized"),
    // not just "not 200" — a weak assertion masks the 401-vs-403 mismatch the FE depends on.
    [Fact]
    public async Task Unsubscribed_session_returns_403_unauthorized()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        // SetSubscribed(false) flips the MutableActivePrCache — RequireSubscribed.Check sees
        // IsSubscribed=false and returns 403 + code "unauthorized". This ONLY works because the
        // context uses MutableActivePrCache, not the hardwired AllSubscribedActivePrCache.
        ctx.SetSubscribed(false);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("unauthorized");
        ctx.Writer.Calls.Should().BeEmpty();
    }

    // ── /merge ────────────────────────────────────────────────────────────────────────────────

    private static HttpRequestMessage PostMerge(object body) =>
        new(HttpMethod.Post, "/api/pr/o/r/1/merge")
        {
            Headers = { { "X-PRism-Tab-Id", "tab-123" } },
            Content = JsonContent.Create(body),
        };

    [Fact]
    public async Task Merge_success_records_method_sha_and_publishes()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Ok;
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(PostMerge(new { method = "squash", headSha = "abc123" }));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Writer.Calls.Should().ContainSingle().Which.Should().Be("merge");
        ctx.Writer.LastMerge.Should().Be((MergeMethod.Squash, "abc123"));
        await TestPoll.UntilAsync(
            () => ctx.Bus.Published.OfType<PrLifecycleChanged>().Any(),
            TimeSpan.FromSeconds(5), "PrLifecycleChanged should publish");
    }

    [Theory]
    [InlineData("{\"method\":\"squash\"}")]                       // headSha missing
    [InlineData("{\"method\":\"squash\",\"headSha\":\"\"}")]      // headSha empty
    public async Task Merge_missing_headSha_returns_400(string json)
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        using var client = ctx.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/pr/o/r/1/merge")
        { Headers = { { "X-PRism-Tab-Id", "tab-123" } }, Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Theory]
    [InlineData("Merge")]   // wrong case — the permissive enum trap
    [InlineData("1")]        // numeric string
    [InlineData("rocket")]   // unknown
    public async Task Merge_invalid_method_returns_400(string method)
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(PostMerge(new { method, headSha = "abc" }));

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Theory]
    [InlineData(PrLifecycleErrorCode.MergeNotMergeable, HttpStatusCode.UnprocessableEntity, "merge-not-mergeable")]
    [InlineData(PrLifecycleErrorCode.MergeHeadChanged, HttpStatusCode.Conflict, "merge-head-changed")]
    public async Task Merge_error_maps_to_status_and_code(PrLifecycleErrorCode err, HttpStatusCode status, string code)
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(err);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(PostMerge(new { method = "merge", headSha = "abc" }));

        resp.StatusCode.Should().Be(status);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be(code);
        ctx.Bus.Published.OfType<PrLifecycleChanged>().Should().BeEmpty();
    }
}
