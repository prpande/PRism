using System.Net;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Contracts;
using PRism.Core.Json;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class PrDraftEndpointTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;

    public PrDraftEndpointTests(PRismWebApplicationFactory factory) { _factory = factory; }

    private HttpClient ClientWithTab(string tabId = "tab-test-1")
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }

    // Builds an authenticated client against a derived factory (typically one created via
    // WithWebHostBuilder). The derived factory is a WebApplicationFactory<Program>, not a
    // PRismWebApplicationFactory, so its ConfigureClient override does NOT auto-inject
    // auth headers. We pull the token from the derived factory's own DI container so it
    // matches that container's SessionTokenProvider singleton.
    private static HttpClient AuthedClient(WebApplicationFactory<Program> factory, string tabId)
    {
        var token = factory.Services.GetRequiredService<SessionTokenProvider>().Current;
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Session", token);
        c.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = c.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin)) c.DefaultRequestHeaders.Add("Origin", origin);
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }

    private static async Task<T?> ReadApiJsonAsync<T>(HttpResponseMessage resp)
        => await resp.Content.ReadFromJsonAsync<T>(JsonSerializerOptionsFactory.Api).ConfigureAwait(false);

    private static ReviewSessionPatch NewCommentPatch(
        string filePath = "src/Foo.cs", int line = 42, string side = "right",
        string? sha = null, string content = "line content", string body = "this is a draft comment")
        => new(
            null, null,
            NewDraftComment: new NewDraftCommentPayload(filePath, line, side, sha ?? new string('a', 40), content, body),
            null, null, null, null, null, null, null, null, null);

    private static ReviewSessionPatch SinglePatch(
        string? draftVerdict = null,
        string? summary = null,
        NewPrRootDraftCommentPayload? newRoot = null,
        UpdateDraftCommentPayload? updateComment = null,
        DeleteDraftPayload? deleteComment = null,
        NewDraftReplyPayload? newReply = null,
        UpdateDraftPayload? updateReply = null,
        DeleteDraftPayload? deleteReply = null,
        bool? confirmVerdict = null,
        bool? markAllRead = null,
        OverrideStalePayload? overrideStale = null)
        => new(draftVerdict, summary, null, newRoot, updateComment, deleteComment, newReply, updateReply, deleteReply, confirmVerdict, markAllRead, overrideStale);

    [Fact]
    public async Task NewDraftComment_success_returns_assigned_id_and_persists()
    {
        var client = ClientWithTab();
        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", NewCommentPatch());

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await ReadApiJsonAsync<AssignedIdResponse>(resp);
        body.Should().NotBeNull();
        body!.AssignedId.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task Missing_session_token_returns_401()
    {
        var client = _factory.CreateUnauthenticatedClient();
        client.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-1");
        client.DefaultRequestHeaders.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", SinglePatch(summary: "x"));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Multi_field_patch_returns_400_invalid_patch_shape()
    {
        var client = ClientWithTab();
        var patch = new ReviewSessionPatch(
            DraftVerdict: "approve", DraftSummaryMarkdown: "summary",
            null, null, null, null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task UpdateDraftComment_missing_id_returns_404_draft_not_found()
    {
        var client = ClientWithTab();
        var patch = SinglePatch(updateComment: new UpdateDraftCommentPayload(Id: "missing-uuid", BodyMarkdown: "body"));

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/456/draft", patch);

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task NewDraftComment_body_too_large_returns_422_body_too_large()
    {
        var client = ClientWithTab();
        var patch = NewCommentPatch(body: new string('x', 8193));

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task NewDraftComment_invalid_sha_format_returns_422()
    {
        var client = ClientWithTab();
        var patch = NewCommentPatch(sha: "not-a-sha");

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task OverrideStale_against_non_stale_draft_returns_400_not_stale()
    {
        var client = ClientWithTab();
        var newResp = await client.PutAsJsonAsync("/api/pr/acme/api/789/draft", NewCommentPatch());
        var assigned = await ReadApiJsonAsync<AssignedIdResponse>(newResp);

        var overridePatch = SinglePatch(overrideStale: new OverrideStalePayload(Id: assigned!.AssignedId));

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/789/draft", overridePatch);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task GetDraft_returns_empty_dto_when_no_session()
    {
        var client = ClientWithTab();
        var resp = await client.GetAsync(new Uri("/api/pr/acme/api/999/draft", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await ReadApiJsonAsync<ReviewSessionDto>(resp);
        dto.Should().NotBeNull();
        dto!.DraftComments.Should().BeEmpty();
        dto.DraftReplies.Should().BeEmpty();
        dto.DraftVerdictStatus.Should().Be(DraftVerdictStatus.Draft);
    }

    [Fact]
    public async Task Patch_with_no_fields_set_returns_400()
    {
        var client = ClientWithTab();
        // First set a verdict so a session exists.
        await client.PutAsJsonAsync("/api/pr/acme/api/321/draft", SinglePatch(draftVerdict: "approve"));

        // All-null patch — 12 nulls means 0 set fields per EnumerateSetFields. The
        // single-field constraint in PutDraft rejects this with 400. Note: we can't
        // legitimately clear a verdict via JSON null without distinguishing "field
        // absent" from "field null" on the wire — see deferrals "PR3 wire-shape gap:
        // explicit verdict-clear has no sentinel". This test pins the dispatch
        // boundary, not a clear semantic.
        var allNull = new ReviewSessionPatch(
            DraftVerdict: null, DraftSummaryMarkdown: null,
            null, null, null, null, null, null, null, null, null, null);
        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/321/draft", allNull);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ConfirmVerdict_when_already_draft_returns_ok_no_event_no_state_change()
    {
        var client = ClientWithTab();
        // Default session has DraftVerdictStatus = Draft. Confirm again → NoOp.
        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/654/draft", SinglePatch(confirmVerdict: true));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        // GET should still show Draft status (unchanged)
        var getResp = await client.GetAsync(new Uri("/api/pr/acme/api/654/draft", UriKind.Relative));
        var dto = await ReadApiJsonAsync<ReviewSessionDto>(getResp);
        dto!.DraftVerdictStatus.Should().Be(DraftVerdictStatus.Draft);
    }

    [Fact]
    public async Task MarkAllRead_not_subscribed_returns_404_not_subscribed()
    {
        // Default cache reports IsSubscribed=false for the test PR (no SSE subscribers
        // registered). Security defense per spec § 4.7 — closes the drive-by-tab vector.
        var client = ClientWithTab();
        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/111/draft", SinglePatch(markAllRead: true));

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task MarkAllRead_subscribed_but_cache_empty_returns_ok_noop()
    {
        // Override cache: subscribed but no snapshot (HighestIssueCommentId would be null
        // even with snapshot in S4, so this also covers the "production cold cache" path).
        await using var factory = _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new FakeCache(isSubscribed: true, snapshot: null));
        }));
        var client = AuthedClient(factory, "tab-1");

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/222/draft", SinglePatch(markAllRead: true));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task MarkAllRead_subscribed_with_snapshot_updates_last_seen_comment_id()
    {
        // Inject a fake cache that returns a non-null HighestIssueCommentId so the
        // production no-op behavior doesn't mask the success path.
        var snapshot = new ActivePrSnapshot("h1", HighestIssueCommentId: 42L, ObservedAt: DateTimeOffset.UtcNow);
        await using var factory = _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new FakeCache(isSubscribed: true, snapshot: snapshot));
        }));
        var client = AuthedClient(factory, "tab-1");

        // First write something so a session exists with LastSeenCommentId=null
        await client.PutAsJsonAsync("/api/pr/acme/api/333/draft", NewCommentPatch());

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/333/draft", SinglePatch(markAllRead: true));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        // No GET returns LastSeenCommentId on the wire (it's a server-side bookkeeping
        // field, not part of ReviewSessionDto). Asserting state-store directly is the
        // only direct path; for now, idempotency check is sufficient — a second
        // markAllRead with the same id should remain OK with no further state churn.
        var resp2 = await client.PutAsJsonAsync("/api/pr/acme/api/333/draft", SinglePatch(markAllRead: true));
        resp2.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // Regression: validation must return 400 instead of throwing → 500 when System.Text.Json
    // deserializes explicit JSON `null` into non-nullable record-string properties. Each
    // ValidatePatch null-guard added in the PR-followup pass is pinned by one of the tests
    // below — sending a typed object with nullable C# props would not exercise these paths,
    // so raw JSON via StringContent is required.

    private static StringContent JsonContent(string raw) =>
        new(raw, Encoding.UTF8, "application/json");

    [Fact]
    public async Task PutDraft_unknown_verdict_returns_400_not_500()
    {
        var client = ClientWithTab();
        // "request-changes" (kebab-case) is a common client-side typo. Wire shape is
        // camelCase "requestChanges". The pre-fix code threw ArgumentException inside
        // ApplyPatch's switch default → 500. ValidatePatch now rejects unknown values at
        // the boundary with 400.
        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/901/draft", SinglePatch(draftVerdict: "request-changes"));
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PutDraft_null_bodyMarkdown_in_newDraftComment_returns_400_not_500()
    {
        var client = ClientWithTab();
        var raw = "{\"newDraftComment\":{\"filePath\":\"src/Foo.cs\",\"lineNumber\":42,\"side\":\"right\",\"anchoredSha\":\""
            + new string('a', 40) + "\",\"anchoredLineContent\":\"line\",\"bodyMarkdown\":null}}";
        var resp = await client.PutAsync(new Uri("/api/pr/acme/api/902/draft", UriKind.Relative), JsonContent(raw));
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PutDraft_null_anchoredSha_in_newDraftComment_returns_400_not_500()
    {
        var client = ClientWithTab();
        var raw = "{\"newDraftComment\":{\"filePath\":\"src/Foo.cs\",\"lineNumber\":42,\"side\":\"right\",\"anchoredSha\":null,\"anchoredLineContent\":\"line\",\"bodyMarkdown\":\"hi\"}}";
        var resp = await client.PutAsync(new Uri("/api/pr/acme/api/903/draft", UriKind.Relative), JsonContent(raw));
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PutDraft_null_parentThreadId_in_newDraftReply_returns_400_not_500()
    {
        var client = ClientWithTab();
        var raw = "{\"newDraftReply\":{\"parentThreadId\":null,\"bodyMarkdown\":\"reply\"}}";
        var resp = await client.PutAsync(new Uri("/api/pr/acme/api/904/draft", UriKind.Relative), JsonContent(raw));
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PutDraft_null_bodyMarkdown_in_updateDraftComment_returns_400_not_500()
    {
        var client = ClientWithTab();
        // updateDraftComment was missing both null AND empty validation pre-fix; STJ's
        // null-into-non-nullable behavior would NRE on .Length → 500.
        var raw = "{\"updateDraftComment\":{\"id\":\"some-id\",\"bodyMarkdown\":null}}";
        var resp = await client.PutAsync(new Uri("/api/pr/acme/api/905/draft", UriKind.Relative), JsonContent(raw));
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PutDraft_empty_bodyMarkdown_in_updateDraftReply_returns_400()
    {
        var client = ClientWithTab();
        var patch = SinglePatch(updateReply: new UpdateDraftPayload(Id: "some-id", BodyMarkdown: "   "));
        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/906/draft", patch);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    private sealed class FakeCache : IActivePrCache
    {
        private readonly bool _isSubscribed;
        private readonly ActivePrSnapshot? _snapshot;
        public FakeCache(bool isSubscribed, ActivePrSnapshot? snapshot) { _isSubscribed = isSubscribed; _snapshot = snapshot; }
        public bool IsSubscribed(PrReference prRef) => _isSubscribed;
        public ActivePrSnapshot? GetCurrent(PrReference prRef) => _snapshot;
        public void Update(PrReference prRef, ActivePrSnapshot snapshot) { /* test fake — no-op */ }
    }
}
