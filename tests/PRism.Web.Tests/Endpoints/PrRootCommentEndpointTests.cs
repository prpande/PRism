using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using FluentAssertions;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// T10 — POST /api/pr/{owner}/{repo}/{number}/root-comment/post
// Posts a PR-root draft (FilePath null, LineNumber null) as a GitHub issue comment WITHOUT
// submitting a review. Shares the per-PR SubmitLockRegistry slot with /submit.
public class PrRootCommentEndpointTests
{
    private static readonly JsonSerializerOptions CamelCase = new(JsonSerializerDefaults.Web);

    // ── session builders ─────────────────────────────────────────────────────

    private static ReviewSessionState SessionWithRootDraft(string bodyMarkdown = "Hello PR root comment") =>
        SubmitEndpointsTestContext.EmptySession() with
        {
            DraftComments = new List<DraftComment>
            {
                new("root-d1", FilePath: null, LineNumber: null, Side: null,
                    AnchoredSha: null, AnchoredLineContent: null,
                    BodyMarkdown: bodyMarkdown, Status: DraftStatus.Draft,
                    IsOverriddenStale: false, PostedCommentId: null, PostedBodySnapshot: null),
            },
        };

    private static ReviewSessionState SessionWithInlineDraftOnly() =>
        SubmitEndpointsTestContext.EmptySession() with
        {
            DraftComments = new List<DraftComment>
            {
                new("inline-d1", "src/Foo.cs", 42, "RIGHT", new string('a', 40), "the line",
                    "inline body", DraftStatus.Draft, false),
            },
        };

    private static ReviewSessionState SessionWithAlreadyPostedSameBody(
        long commentId = 99, string bodyMarkdown = "Hello PR root comment") =>
        SubmitEndpointsTestContext.EmptySession() with
        {
            DraftComments = new List<DraftComment>
            {
                new("root-d1", FilePath: null, LineNumber: null, Side: null,
                    AnchoredSha: null, AnchoredLineContent: null,
                    BodyMarkdown: bodyMarkdown, Status: DraftStatus.Draft,
                    IsOverriddenStale: false, PostedCommentId: commentId,
                    PostedBodySnapshot: bodyMarkdown /* same body */),
            },
        };

    private static ReviewSessionState SessionWithAlreadyPostedDifferentBody(long commentId = 99) =>
        SubmitEndpointsTestContext.EmptySession() with
        {
            DraftComments = new List<DraftComment>
            {
                new("root-d1", FilePath: null, LineNumber: null, Side: null,
                    AnchoredSha: null, AnchoredLineContent: null,
                    BodyMarkdown: "new body (edited)", Status: DraftStatus.Draft,
                    IsOverriddenStale: false, PostedCommentId: commentId,
                    PostedBodySnapshot: "original posted body"),
            },
        };

    // ── happy path ───────────────────────────────────────────────────────────

    [Fact]
    public async Task PostRootComment_happy_path_returns_204_and_records_comment()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 10, SessionWithRootDraft("Hello PR root comment"));

        var resp = await ctx.Post(10);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // GitHub call was made
        ctx.Submitter.IssueComments.Should().ContainSingle()
            .Which.Body.Should().Be("Hello PR root comment");

        // Draft deleted
        var session = await ctx.LoadSessionAsync("o", "r", 10);
        session!.DraftComments.Should().BeEmpty("draft must be deleted after successful post");

        // Bus events published
        ctx.Bus.Published.OfType<StateChanged>().Should().NotBeEmpty();
        ctx.Bus.Published.OfType<RootCommentPostedBusEvent>()
            .Should().ContainSingle().Which.IssueCommentId.Should().BeGreaterThan(0);
    }

    // ── no-session ───────────────────────────────────────────────────────────

    [Fact]
    public async Task PostRootComment_no_session_returns_400_no_session()
    {
        using var ctx = RootCommentTestContext.Create();
        // No session seeded.

        var resp = await ctx.Post(20);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("no-session");
    }

    // ── no-root-draft ────────────────────────────────────────────────────────

    [Fact]
    public async Task PostRootComment_no_root_draft_returns_400_no_root_draft()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 21, SessionWithInlineDraftOnly());

        var resp = await ctx.Post(21);

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("no-root-draft");
    }

    // ── already-posted same body (idempotent) ────────────────────────────────

    [Fact]
    public async Task PostRootComment_already_posted_same_body_returns_204_no_github_call()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 22, SessionWithAlreadyPostedSameBody(commentId: 99));

        var resp = await ctx.Post(22);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
        ctx.Submitter.IssueComments.Should().BeEmpty("idempotent re-post of same body must not call GitHub again");

        var session = await ctx.LoadSessionAsync("o", "r", 22);
        session!.DraftComments.Should().BeEmpty("draft must be deleted on idempotent path");

        ctx.Bus.Published.OfType<StateChanged>().Should().NotBeEmpty();
    }

    // ── already-posted different body (mismatch) → 409 ──────────────────────

    [Fact]
    public async Task PostRootComment_already_posted_different_body_returns_409_mismatch()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 23, SessionWithAlreadyPostedDifferentBody(commentId: 99));

        var resp = await ctx.Post(23);

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("already-posted-body-mismatch");
        body.GetProperty("postedCommentId").GetInt64().Should().Be(99);
    }

    // ── GitHub failure → 502 ─────────────────────────────────────────────────

    [Fact]
    public async Task PostRootComment_force_failure_returns_502()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 24, SessionWithRootDraft());
        // Forbidden carrying a raw GitHub error body — the response must sanitize it to the static
        // per-code string and NOT leak the raw body (GitHubReviewService embeds up to 512 bytes of it).
        ctx.Submitter.InjectFailure(new HttpRequestException(
            "GitHub issue comment POST HTTP 403 Forbidden: {\"message\":\"RAW_GITHUB_SECRET_BODY\"}",
            null, System.Net.HttpStatusCode.Forbidden));

        var resp = await ctx.Post(24);

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("github-forbidden");
        var message = body.GetProperty("message").GetString();
        message.Should().Be("GitHub rejected the request (forbidden). Check your token's permissions.");
        message.Should().NotContain("RAW_GITHUB_SECRET_BODY", "the raw GitHub error body must not leak to the client");

        // State-preservation: the endpoint returns 502 BEFORE the stamp/delete overlays run.
        // The PR-root draft must still exist, PostedCommentId must still be null (not stamped),
        // and DraftComments count must be unchanged (draft not deleted).
        var session = await ctx.LoadSessionAsync("o", "r", 24);
        session.Should().NotBeNull("session must survive a GitHub failure");
        session!.DraftComments.Should().HaveCount(1, "draft must not be deleted on GitHub failure");
        var rootDraft = session.DraftComments.Single(d => d.FilePath is null && d.LineNumber is null);
        rootDraft.PostedCommentId.Should().BeNull("PostedCommentId must not be stamped when the GitHub call fails");
    }

    // ── malformed-2xx (GitHubRestContractException) → 502 github-network-error ──

    [Fact]
    public async Task PostRootComment_contract_exception_maps_to_502_github_network_error()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 24, SessionWithRootDraft());
        ctx.Submitter.InjectFailure(new PRism.GitHub.GitHubRestContractException("missing 'id'"));

        var resp = await ctx.Post(24);

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        // Not an HttpRequestException ⇒ the catch-all yields github-network-error,
        // NOT the 403 path's github-forbidden.
        body.GetProperty("code").GetString().Should().Be("github-network-error");
    }

    // ── lock held → 409 ─────────────────────────────────────────────────────

    [Fact]
    public async Task PostRootComment_lock_held_returns_409_submit_in_progress()
    {
        using var ctx = RootCommentTestContext.Create();

        // Hold the SubmitLockRegistry slot by starting /submit with a long BeginDelay so the
        // fire-and-forget pipeline keeps the lock while we POST /root-comment/post.
        // ValidSession() seeds a "tab-test" stamp at HeadSha="head1"; the submit client must
        // send X-PRism-Tab-Id: tab-test so the tab-id-missing gate passes.
        ctx.Submitter.BeginDelay = TimeSpan.FromSeconds(3);
        await ctx.SeedSessionAsync("o", "r", 25, SubmitEndpointsTestContext.ValidSession());

        using var submitClient = ctx.CreateClient(tabId: "tab-test");
        var submitResp = await submitClient.PostAsJsonAsync("/api/pr/o/r/25/submit", new { verdict = "comment" });
        submitResp.StatusCode.Should().Be(HttpStatusCode.OK, "submit must start and hold the lock");

        // Immediately POST /root-comment/post — the lock is held → must get 409.
        var resp = await ctx.Post(25);

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("submit-in-progress");
    }

    // ── unauthorized ─────────────────────────────────────────────────────────

    [Fact]
    public async Task PostRootComment_unauthorized_returns_403()
    {
        using var ctx = RootCommentTestContext.Create(subscribeAll: false);
        await ctx.SeedSessionAsync("o", "r", 26, SessionWithRootDraft());

        var resp = await ctx.Post(26);

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("unauthorized");
    }
}

// ─── Test infrastructure ─────────────────────────────────────────────────────────────

/// <summary>
/// IReviewSubmitter stub that properly implements CreateIssueCommentAsync and
/// delegates everything else to TestReviewSubmitter (so the /submit fire-and-forget
/// pipeline works for the lock-held test).
/// </summary>
internal sealed class TestRootCommentSubmitter : IReviewSubmitter
{
    private readonly TestReviewSubmitter _inner = new();
    private Exception? _nextFailure;
    private long _nextId = 1;

    public TimeSpan BeginDelay
    {
        get => _inner.BeginDelay;
        set => _inner.BeginDelay = value;
    }

    public List<(PrReference Pr, string Body)> IssueComments { get; } = new();

    public void InjectFailure(Exception ex) => _nextFailure = ex;

    public Task<BeginPendingReviewResult> BeginPendingReviewAsync(
        PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
        => _inner.BeginPendingReviewAsync(reference, commitOid, summaryBody, ct);

    public Task<AttachThreadResult> AttachThreadAsync(
        PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
        => _inner.AttachThreadAsync(reference, pendingReviewId, draft, ct);

    public Task<AttachReplyResult> AttachReplyAsync(
        PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
        => _inner.AttachReplyAsync(reference, pendingReviewId, parentThreadId, replyBody, ct);

    public Task FinalizePendingReviewAsync(
        PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
        => _inner.FinalizePendingReviewAsync(reference, pendingReviewId, verdict, ct);

    public Task DeletePendingReviewAsync(
        PrReference reference, string pendingReviewId, CancellationToken ct)
        => _inner.DeletePendingReviewAsync(reference, pendingReviewId, ct);

    public Task DeletePendingReviewThreadAsync(
        PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
        => _inner.DeletePendingReviewThreadAsync(reference, pullRequestReviewThreadId, ct);

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(
        PrReference reference, CancellationToken ct)
        => _inner.FindOwnPendingReviewAsync(reference, ct);

    public Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
        PrReference reference, string bodyMarkdown, CancellationToken ct)
    {
        if (_nextFailure is { } ex)
        {
            _nextFailure = null;
            return Task.FromException<CreatedIssueCommentResult>(ex);
        }
        var id = Interlocked.Increment(ref _nextId);
        IssueComments.Add((reference, bodyMarkdown));
        return Task.FromResult(new CreatedIssueCommentResult(id, DateTimeOffset.UtcNow));
    }

    public Task<CreatedReviewCommentResult> CreateReviewCommentAsync(PrReference reference, ReviewCommentRequest request, CancellationToken ct)
        => throw new NotImplementedException();

    public Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct)
        => throw new NotImplementedException();
}

/// <summary>IActivePrCache whose IsSubscribed behaviour is constructor-controlled.</summary>
internal sealed class ConfigurableActivePrCache : IActivePrCache
{
    private readonly bool _subscribeAll;
    public ActivePrSnapshot? Current { get; set; }

    public ConfigurableActivePrCache(bool subscribeAll) => _subscribeAll = subscribeAll;

    public bool IsSubscribed(PrReference prRef) => _subscribeAll;
    public ActivePrSnapshot? GetCurrent(PrReference prRef) => Current;
    public void Update(PrReference prRef, ActivePrSnapshot snapshot) => Current = snapshot;
    public void Clear() => Current = null;
}

/// <summary>
/// Per-test harness for the root-comment endpoint. Mirrors SubmitEndpointsTestContext but
/// wires TestRootCommentSubmitter (working CreateIssueCommentAsync) and ConfigurableActivePrCache.
/// </summary>
internal sealed class RootCommentTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;

    public TestRootCommentSubmitter Submitter { get; } = new();
    public FakeReviewEventBus Bus { get; } = new();
    public ConfigurableActivePrCache ActivePrCache { get; }

    private RootCommentTestContext(bool subscribeAll)
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

    public static RootCommentTestContext Create(bool subscribeAll = true) => new(subscribeAll);

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

    public async Task<HttpResponseMessage> Post(int number, string owner = "o", string repo = "r")
    {
        using var client = CreateClient();
        return await client.PostAsync(
            new Uri($"/api/pr/{owner}/{repo}/{number}/root-comment/post", UriKind.Relative), null);
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
