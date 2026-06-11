using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using FluentAssertions;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using PRism.Core;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Task 6 — POST /api/pr/{owner}/{repo}/{number}/comment/post
// Posts a single inline comment (DraftComment) or reply (DraftReply) directly, without a review.
// Discriminates by draft KIND: DraftComments → inline REST; DraftReplies → reply GraphQL.
// Returns 200 { postedCommentId } on success.
public class PrCommentEndpointTests
{
    private static readonly JsonSerializerOptions CamelCase = new(JsonSerializerDefaults.Web);

    // ── session builders ─────────────────────────────────────────────────────

    // A standard inline draft with all required anchor fields.
    private static ReviewSessionState SessionWithInlineDraft(
        string draftId = "d1",
        string body = "inline comment body",
        string anchoredSha = "deadbeef",
        string? filePath = "src/Foo.cs",
        int? lineNumber = 42,
        string? side = "RIGHT",
        long? postedCommentId = null,
        string? postedBodySnapshot = null) =>
        SubmitEndpointsTestContext.EmptySession() with
        {
            DraftComments = new List<DraftComment>
            {
                new(draftId, FilePath: filePath, LineNumber: lineNumber, Side: side,
                    AnchoredSha: anchoredSha, AnchoredLineContent: "the line",
                    BodyMarkdown: body, Status: DraftStatus.Draft,
                    IsOverriddenStale: false, PostedCommentId: postedCommentId,
                    PostedBodySnapshot: postedBodySnapshot),
            },
        };

    // A standard reply draft with all required fields.
    private static ReviewSessionState SessionWithReplyDraft(
        string draftId = "r1",
        string body = "reply body",
        string parentThreadId = "PRRT_abc",
        long? postedCommentId = null,
        string? postedBodySnapshot = null) =>
        SubmitEndpointsTestContext.EmptySession() with
        {
            DraftReplies = new List<DraftReply>
            {
                new(draftId, ParentThreadId: parentThreadId, ReplyCommentId: null,
                    BodyMarkdown: body, Status: DraftStatus.Draft,
                    IsOverriddenStale: false, PostedCommentId: postedCommentId,
                    PostedBodySnapshot: postedBodySnapshot),
            },
        };

    // ── 1. Inline post: happy path ────────────────────────────────────────────

    [Fact]
    public async Task PostComment_inline_happy_path_returns_200_with_postedCommentId()
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, SessionWithInlineDraft());

        var resp = await ctx.Post(1, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("postedCommentId").GetInt64().Should().BeGreaterThan(0);

        // GitHub call was made exactly once for the inline draft
        ctx.Submitter.ReviewComments.Should().ContainSingle();
        ctx.Submitter.ReviewCommentReplies.Should().BeEmpty();

        // Draft was deleted
        var session = await ctx.LoadSessionAsync("o", "r", 1);
        session!.DraftComments.Should().BeEmpty("draft must be deleted after successful post");

        // Bus events published
        ctx.Bus.Published.OfType<StateChanged>().Should().NotBeEmpty();
        ctx.Bus.Published.OfType<SingleCommentPostedBusEvent>()
            .Should().ContainSingle().Which.ReviewCommentId.Should().BeGreaterThan(0);
    }

    // ── 2. Reply post: happy path ─────────────────────────────────────────────

    [Fact]
    public async Task PostComment_reply_happy_path_returns_200_with_postedCommentId()
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 2, SessionWithReplyDraft("r1", "reply body", "PRRT_abc"));

        var resp = await ctx.Post(2, "r1");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("postedCommentId").GetInt64().Should().BeGreaterThan(0);

        // GitHub call via reply path (GraphQL)
        ctx.Submitter.ReviewCommentReplies.Should().ContainSingle()
            .Which.ParentThreadId.Should().Be("PRRT_abc");
        ctx.Submitter.ReviewComments.Should().BeEmpty("inline path must not fire for a reply");

        // Draft was deleted
        var session = await ctx.LoadSessionAsync("o", "r", 2);
        session!.DraftReplies.Should().BeEmpty("reply draft must be deleted after successful post");
    }

    // ── 3. Idempotent re-post (same body) → 200, no GitHub call ─────────────

    [Fact]
    public async Task PostComment_idempotent_repost_same_body_returns_200_no_github_call()
    {
        const long existingId = 999L;
        const string body = "inline comment body";
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 3, SessionWithInlineDraft(
            draftId: "d1", body: body, postedCommentId: existingId, postedBodySnapshot: body));

        var resp = await ctx.Post(3, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var respBody = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        respBody.GetProperty("postedCommentId").GetInt64().Should().Be(existingId);

        // No GitHub call — idempotent
        ctx.Submitter.ReviewComments.Should().BeEmpty();
        ctx.Submitter.ReviewCommentReplies.Should().BeEmpty();

        // Draft was deleted
        var session = await ctx.LoadSessionAsync("o", "r", 3);
        session!.DraftComments.Should().BeEmpty("draft must be deleted on idempotent re-post");
    }

    // ── 4. Body mismatch → 409 PostMismatchErrorDto ───────────────────────────

    [Fact]
    public async Task PostComment_body_mismatch_returns_409_mismatch()
    {
        const long existingId = 888L;
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 4, SessionWithInlineDraft(
            draftId: "d1", body: "edited body", postedCommentId: existingId,
            postedBodySnapshot: "original body"));

        var resp = await ctx.Post(4, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("already-posted-body-mismatch");
        body.GetProperty("postedCommentId").GetInt64().Should().Be(existingId);

        // No GitHub call
        ctx.Submitter.ReviewComments.Should().BeEmpty();
    }

    // ── 5. Cross-session draftId → 400 no-draft ──────────────────────────────

    [Fact]
    public async Task PostComment_cross_session_draftId_returns_400_no_draft()
    {
        using var ctx = CommentTestContext.Create();
        // Seed PR #5 with draft "d-prB"
        await ctx.SeedSessionAsync("o", "r", 5, SessionWithInlineDraft(draftId: "d-prB"));
        // Post to PR #6 (no session seeded) asking for "d-prB"
        await ctx.SeedSessionAsync("o", "r", 6, SubmitEndpointsTestContext.EmptySession());

        var resp = await ctx.Post(6, "d-prB");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("no-draft");

        ctx.Submitter.ReviewComments.Should().BeEmpty("cross-session must not call GitHub");
    }

    // ── 6. Empty AnchoredSha → 400 missing-anchor ────────────────────────────

    [Fact]
    public async Task PostComment_empty_anchored_sha_returns_400_missing_anchor()
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 7, SessionWithInlineDraft(draftId: "d1", anchoredSha: ""));

        var resp = await ctx.Post(7, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("missing-anchor");

        ctx.Submitter.ReviewComments.Should().BeEmpty("must not call GitHub when anchor is missing");
    }

    // ── 6b. Empty/whitespace ParentThreadId → 400 missing-thread ─────────────

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task PostComment_empty_parent_thread_id_returns_400_missing_thread(string parentThreadId)
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 11, SessionWithReplyDraft(draftId: "r1", parentThreadId: parentThreadId));

        var resp = await ctx.Post(11, "r1");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("missing-thread");

        ctx.Submitter.ReviewCommentReplies.Should().BeEmpty("must not call GitHub when ParentThreadId is missing");
    }

    // ── 7. Unauthorized → 401 ─────────────────────────────────────────────────

    [Fact]
    public async Task PostComment_unauthorized_returns_401()
    {
        using var ctx = CommentTestContext.Create(subscribeAll: false);
        await ctx.SeedSessionAsync("o", "r", 8, SessionWithInlineDraft());

        var resp = await ctx.Post(8, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("unauthorized");
    }

    // ── 8. GitHub 5xx → 502 sanitized ────────────────────────────────────────

    [Fact]
    public async Task PostComment_github_5xx_returns_502_sanitized()
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 9, SessionWithInlineDraft());
        ctx.Submitter.InjectReviewCommentFailure(new HttpRequestException(
            "GitHub review comment POST HTTP 503 ServiceUnavailable: {\"message\":\"RAW_SECRET_UPSTREAM_BODY\"}",
            null, System.Net.HttpStatusCode.ServiceUnavailable));

        var resp = await ctx.Post(9, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("github-network-error");
        var message = body.GetProperty("message").GetString();
        message.Should().NotContain("RAW_SECRET_UPSTREAM_BODY", "raw upstream body must not leak to the client");
    }

    // ── 8b. GitHub malformed-2xx (GitHubRestContractException) → same 502 as a transport error ──

    [Fact]
    public async Task PostComment_inline_contract_exception_maps_to_502_github_network_error()
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, SessionWithInlineDraft());
        ctx.Submitter.InjectReviewCommentFailure(
            new PRism.GitHub.GitHubRestContractException("missing 'id'"));

        var resp = await ctx.Post(1, "d1");

        // GitHubRestContractException is not an HttpRequestException ⇒ it hits the endpoint's
        // catch-all, producing the same 502 / github-network-error as a transport failure.
        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("github-network-error");
    }

    // ── 9. Lock held → 409 submit-in-progress ─────────────────────────────────

    [Fact]
    public async Task PostComment_lock_held_returns_409_submit_in_progress()
    {
        using var ctx = CommentTestContext.Create();

        // Hold the SubmitLockRegistry slot by starting /submit with a long BeginDelay so the
        // fire-and-forget pipeline keeps the lock while we POST /comment/post for the same PR.
        // ValidSession() seeds a "tab-test" stamp at HeadSha="head1"; the submit client must
        // send X-PRism-Tab-Id: tab-test so the tab-id-missing gate passes.
        ctx.Submitter.BeginDelay = TimeSpan.FromSeconds(3);
        await ctx.SeedSessionAsync("o", "r", 10, SubmitEndpointsTestContext.ValidSession());

        using var submitClient = ctx.CreateClient(tabId: "tab-test");
        var submitResp = await submitClient.PostAsJsonAsync("/api/pr/o/r/10/submit", new { verdict = "Comment" });
        submitResp.StatusCode.Should().Be(HttpStatusCode.OK, "submit must start and hold the lock");

        // Immediately POST /comment/post — the lock is held → must get 409.
        var resp = await ctx.Post(10, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("submit-in-progress");

        // No GitHub submitter call for the comment post (it was rejected before reaching the submitter).
        ctx.Submitter.ReviewComments.Should().BeEmpty("lock-contention must not reach the GitHub submitter");
        ctx.Submitter.ReviewCommentReplies.Should().BeEmpty();
    }
}

// ─── Test infrastructure ──────────────────────────────────────────────────────────────

/// <summary>
/// Per-test harness for POST /comment/post. Wires TestReviewSubmitter (with recording
/// CreateReviewComment* methods), FakeReviewEventBus, and ConfigurableActivePrCache.
/// Mirrors RootCommentTestContext in structure.
/// </summary>
internal sealed class CommentTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;

    public TestReviewSubmitter Submitter { get; } = new();
    public FakeReviewEventBus Bus { get; } = new();
    public ConfigurableActivePrCache ActivePrCache { get; }

    private CommentTestContext(bool subscribeAll)
    {
        ActivePrCache = new ConfigurableActivePrCache(subscribeAll);
        _base = new PRismWebApplicationFactory();
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IReviewSubmitter>();
            s.AddSingleton<IReviewSubmitter>(Submitter);
            s.RemoveAll<IReviewEventBus>();
            s.AddSingleton<IReviewEventBus>(Bus);
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(ActivePrCache);
        }));
        _ = _derived.Services;
    }

    public static CommentTestContext Create(bool subscribeAll = true) => new(subscribeAll);

    private IAppStateStore StateStore =>
        _derived.Services.GetRequiredService<IAppStateStore>();

    public HttpClient CreateClient(string? tabId = null)
    {
        var token = _derived.Services.GetRequiredService<SessionTokenProvider>().Current;
        var c = _derived.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Session", token);
        c.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = c.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin)) c.DefaultRequestHeaders.Add("Origin", origin);
        if (!string.IsNullOrEmpty(tabId)) c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }

    public async Task<HttpResponseMessage> Post(int number, string draftId, string owner = "o", string repo = "r")
    {
        using var client = CreateClient();
        return await client.PostAsJsonAsync(
            new Uri($"/api/pr/{owner}/{repo}/{number}/comment/post", UriKind.Relative),
            new { draftId });
    }

    public async Task SeedSessionAsync(string owner, string repo, int number, ReviewSessionState session)
    {
        var key = $"{owner}/{repo}/{number}";
        await StateStore.UpdateAsync(state =>
        {
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [key] = session };
            return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
        }, CancellationToken.None).ConfigureAwait(false);
    }

    public async Task<ReviewSessionState?> LoadSessionAsync(string owner, string repo, int number)
    {
        var state = await StateStore.LoadAsync(CancellationToken.None).ConfigureAwait(false);
        return state.Reviews.Sessions.TryGetValue($"{owner}/{repo}/{number}", out var s) ? s : null;
    }

    public void Dispose()
    {
        _derived.Dispose();
        _base.Dispose();
    }
}
