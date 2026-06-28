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
using PRism.Web.Endpoints;
using PRism.Web.Submit;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// T11 — POST /api/pr/{owner}/{repo}/{number}/submit/discard
// Cancels an in-flight submit pipeline (if any) and clears the user's own pending-review
// stamps so they can start fresh.
[Collection("SubmitDiscardSerial")]
public class PrSubmitDiscardEndpointTests
{
    private static readonly JsonSerializerOptions CamelCase = new(JsonSerializerDefaults.Web);

    // ── happy path: no in-flight, no pending review → 204, idempotent ───────

    [Fact]
    public async Task Discard_when_idle_no_pending_review_clears_and_returns_204()
    {
        using var ctx = DiscardTestContext.Create();
        // Session has stamps but no pending review.
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = null,
            PendingReviewCommitOid = null,
        };
        await ctx.SeedSessionAsync("o", "r", 101, session);

        // No FindOwnPendingReview → null (no existing pending review on GitHub either).
        ctx.Submitter.OwnPendingReview = null;

        var resp = await ctx.Discard(101);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Stamps should be cleared (idempotent — already null, but overlay runs).
        var loaded = await ctx.LoadSessionAsync("o", "r", 101);
        loaded!.PendingReviewId.Should().BeNull();
        loaded.PendingReviewCommitOid.Should().BeNull();
    }

    // ── 404 from GitHub on Delete treated as success → 204, stamps cleared ──

    [Fact]
    public async Task Discard_github_delete_404_treated_as_success_204()
    {
        using var ctx = DiscardTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = "PRR_existing",
            PendingReviewCommitOid = "sha1",
            DraftComments = new List<DraftComment>
            {
                new("d1", "src/Foo.cs", 1, "RIGHT", new string('a', 40), "x", "body",
                    DraftStatus.Draft, false, ThreadId: "PRRT_t1"),
            },
        };
        await ctx.SeedSessionAsync("o", "r", 102, session);

        // FindOwn returns a snapshot; Delete throws 404.
        ctx.Submitter.OwnPendingReview = new OwnPendingReviewSnapshot(
            "PRR_existing", "sha1", DateTimeOffset.UtcNow,
            Array.Empty<PendingReviewThreadSnapshot>());
        ctx.Submitter.DeletePendingReviewException =
            new HttpRequestException("Not Found", null, System.Net.HttpStatusCode.NotFound);

        var resp = await ctx.Discard(102);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var loaded = await ctx.LoadSessionAsync("o", "r", 102);
        loaded!.PendingReviewId.Should().BeNull("stamps cleared even on 404-from-GitHub");
        loaded.DraftComments[0].ThreadId.Should().BeNull("ThreadId cleared by ClearPendingReviewStamps");
    }

    // ── GitHub forbidden on Delete → 403 (#605 item E; was 502), stamps NOT cleared ──

    [Fact]
    public async Task Discard_github_forbidden_returns_403_and_leaves_stamps()
    {
        using var ctx = DiscardTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = "PRR_existing",
            PendingReviewCommitOid = "sha1",
        };
        await ctx.SeedSessionAsync("o", "r", 103, session);

        ctx.Submitter.OwnPendingReview = new OwnPendingReviewSnapshot(
            "PRR_existing", "sha1", DateTimeOffset.UtcNow,
            Array.Empty<PendingReviewThreadSnapshot>());
        // Forbidden carrying a raw GitHub error body in the exception message — the response must
        // sanitize it to the static per-code string and NOT leak the raw body to the client.
        ctx.Submitter.DeletePendingReviewException =
            new HttpRequestException(
                "GitHub pending-review DELETE HTTP 403 Forbidden: {\"message\":\"RAW_GITHUB_SECRET_BODY\"}",
                null, System.Net.HttpStatusCode.Forbidden);

        var resp = await ctx.Discard(103);

        // #605 item E — an auth-class GitHub failure now surfaces its real status (403), not a
        // 502 that reads as transient. The sanitized `code` / message and stamp-preservation are
        // unchanged.
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("github-forbidden");
        var message = body.GetProperty("message").GetString();
        message.Should().Be("GitHub rejected the request (forbidden). Check your token's permissions.");
        message.Should().NotContain("RAW_GITHUB_SECRET_BODY", "the raw GitHub error body must not leak to the client");

        var loaded = await ctx.LoadSessionAsync("o", "r", 103);
        loaded!.PendingReviewId.Should().Be("PRR_existing", "stamps must NOT be cleared on GitHub error");
    }

    // ── GitHub 5xx on FindOwn → 502, stamps NOT cleared ─────────────────────

    [Fact]
    public async Task Discard_github_5xx_on_find_own_returns_502_and_leaves_stamps()
    {
        using var ctx = DiscardTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = "PRR_existing",
            PendingReviewCommitOid = "sha1",
        };
        await ctx.SeedSessionAsync("o", "r", 104, session);

        ctx.Submitter.FindOwnException =
            new HttpRequestException("Internal Server Error", null, System.Net.HttpStatusCode.InternalServerError);

        var resp = await ctx.Discard(104);

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);

        var loaded = await ctx.LoadSessionAsync("o", "r", 104);
        loaded!.PendingReviewId.Should().Be("PRR_existing", "stamps must NOT be cleared on GitHub find error");
    }

    // ── non-HttpRequestException from FindOwn → 502 "github-network-error", stamps preserved ──

    [Fact]
    public async Task Discard_non_http_exception_on_find_own_returns_502_github_network_error_and_leaves_stamps()
    {
        using var ctx = DiscardTestContext.Create();
        var session = SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = "PRR_existing",
            PendingReviewCommitOid = "sha1",
        };
        await ctx.SeedSessionAsync("o", "r", 105, session);

        // Inject a non-HTTP exception (e.g. JSON deserialization failure in the GitHub SDK).
        ctx.Submitter.FindOwnException = new InvalidOperationException("Simulated non-HTTP GitHub SDK failure");

        var resp = await ctx.Discard(105);

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("github-network-error");

        var loaded = await ctx.LoadSessionAsync("o", "r", 105);
        loaded!.PendingReviewId.Should().Be("PRR_existing", "stamps must NOT be cleared on non-HTTP GitHub exception");
    }

    // ── unauthorized → 403 ───────────────────────────────────────────────────

    [Fact]
    public async Task Discard_unauthorized_returns_403()
    {
        using var ctx = DiscardTestContext.Create(subscribeAll: false);

        var resp = await ctx.Discard(199);

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("unauthorized");
    }

    // ── cancels in-flight submit ─────────────────────────────────────────────

    [Fact]
    public async Task Discard_cancels_in_flight_submit_returns_204_and_clears_stamps()
    {
        using var ctx = DiscardTestContext.Create();
        // ValidSession has a draft + Comment verdict, satisfying all submit rules.
        await ctx.SeedSessionAsync("o", "r", 200, SubmitEndpointsTestContext.ValidSession());

        // Seed a pending review so FindOwnPendingReviewAsync returns something; pre-stamp a
        // PendingReviewId into the session so ClearPendingReviewStamps has something to clear.
        ctx.Submitter.OwnPendingReview = new OwnPendingReviewSnapshot(
            "PRR_inflight", "sha1", DateTimeOffset.UtcNow,
            Array.Empty<PendingReviewThreadSnapshot>());

        // Hold BeginPendingReviewAsync so the pipeline stays stuck inside its Begin step.
        ctx.Submitter.BeginDelay = TimeSpan.FromSeconds(10);

        // Fire submit — this returns 200 immediately (fire-and-forget); pipeline holds the lock.
        using var submitClient = ctx.CreateClient(tabId: "tab-test");
        var submitResp = await submitClient.PostAsJsonAsync("/api/pr/o/r/200/submit", new { verdict = "comment" });
        submitResp.StatusCode.Should().Be(HttpStatusCode.OK, "submit must start and hold the lock");

        // Stamp the PendingReviewId into the session so discard has something to clear.
        await ctx.SeedPendingReviewIdAsync("o", "r", 200, "PRR_inflight");

        // POST discard — this signals cancellation and waits (up to 30s) for the pipeline to
        // release the lock. Since BeginPendingReviewAsync is the stuck step and it checks ct,
        // cancellation propagates through the Task.Delay inside BeginPendingReviewAsync and the
        // pipeline exits quickly. The discard then acquires the lock and completes.
        var resp = await ctx.Discard(200, timeout: TimeSpan.FromSeconds(15));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var loaded = await ctx.LoadSessionAsync("o", "r", 200);
        loaded!.PendingReviewId.Should().BeNull("discard clears the pending-review stamps");
    }

    // Note: the foreign-pending-review discard → 204 contract is pinned by
    // PrSubmitEndpointsTests.PostDiscard_TOCTOU_pass_deletes_pending_review_and_clears_session_returns_204
    // (the pre-existing TOCTOU success test, flipped 200→204 in this PR). A duplicate test here
    // was dropped to avoid redundant coverage of the same endpoint/path/assertions.

    // ── pipeline-cancellation-timeout → 504 ─────────────────────────────────

    [Fact]
    public async Task Discard_timeout_returns_504_when_lock_cannot_be_acquired()
    {
        using var ctx = DiscardTestContext.Create();
        // Shorten the timeout seam to 200ms so this test does not wait 30 seconds.
        // DiscardTimeouts is an internal class in PRism.Web exposed to tests via
        // InternalsVisibleTo. The original value is restored in finally so parallel tests
        // that call discard normally are not affected.
        var original = DiscardTimeouts.LockAcquireTimeout;
        DiscardTimeouts.LockAcquireTimeout = TimeSpan.FromMilliseconds(200);
        try
        {
            var lockRegistry = ctx.Services.GetRequiredService<SubmitLockRegistry>();
            var prRef = new PRism.Core.Contracts.PrReference("o", "r", 300);
            // Acquire the lock on a background thread; release only after the assertion.
            var acquiredTcs = new TaskCompletionSource<SubmitLockHandle>(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseTcs = new TaskCompletionSource();
            _ = Task.Run(async () =>
            {
                var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.FromSeconds(5), CancellationToken.None);
                if (handle is not null)
                {
                    acquiredTcs.SetResult(handle);
                    await releaseTcs.Task;
                    await handle.DisposeAsync();
                }
                else
                {
                    acquiredTcs.SetException(new InvalidOperationException("Could not acquire lock for test setup"));
                }
            });

            // Wait until the background task holds the lock before sending discard.
            await acquiredTcs.Task;

            var resp = await ctx.Discard(300, timeout: TimeSpan.FromSeconds(5));

            resp.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
            var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
            body.GetProperty("code").GetString().Should().Be("pipeline-cancellation-timeout");

            releaseTcs.SetResult();
        }
        finally
        {
            DiscardTimeouts.LockAcquireTimeout = original;
        }
    }
}

// ─── Test infrastructure ──────────────────────────────────────────────────────

/// <summary>
/// IReviewSubmitter stub for discard endpoint tests. Extends TestReviewSubmitter with
/// configurable FindOwnPendingReviewAsync failure injection.
/// </summary>
internal sealed class DiscardTestSubmitter : IReviewSubmitter
{
    private readonly TestReviewSubmitter _inner = new();

    public OwnPendingReviewSnapshot? OwnPendingReview
    {
        get => _inner.OwnPendingReview;
        set => _inner.OwnPendingReview = value;
    }

    public TimeSpan BeginDelay
    {
        get => _inner.BeginDelay;
        set => _inner.BeginDelay = value;
    }

    public Exception? DeletePendingReviewException
    {
        get => _inner.DeletePendingReviewException;
        set => _inner.DeletePendingReviewException = value;
    }

    // Injected failure for FindOwnPendingReviewAsync (not on the inner stub).
    public Exception? FindOwnException { get; set; }

    public bool FinalizeCalled => _inner.FinalizeCalled;

    public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
        => _inner.BeginPendingReviewAsync(reference, commitOid, summaryBody, ct);

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
        => _inner.AttachThreadAsync(reference, pendingReviewId, draft, ct);

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
        => _inner.AttachReplyAsync(reference, pendingReviewId, parentThreadId, replyBody, ct);

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
        => _inner.FinalizePendingReviewAsync(reference, pendingReviewId, verdict, ct);

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
        => _inner.DeletePendingReviewAsync(reference, pendingReviewId, ct);

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
        => _inner.DeletePendingReviewThreadAsync(reference, pullRequestReviewThreadId, ct);

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
    {
        if (FindOwnException is not null)
        {
            var ex = FindOwnException;
            FindOwnException = null;
            return Task.FromException<OwnPendingReviewSnapshot?>(ex);
        }
        return _inner.FindOwnPendingReviewAsync(reference, ct);
    }

    public Task<CreatedIssueCommentResult> CreateIssueCommentAsync(PrReference reference, string bodyMarkdown, CancellationToken ct)
        => throw new NotImplementedException("CreateIssueCommentAsync is not exercised by DiscardTestSubmitter.");

    public Task<CreatedReviewCommentResult> CreateReviewCommentAsync(PrReference reference, ReviewCommentRequest request, CancellationToken ct)
        => throw new NotImplementedException();

    public Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct)
        => throw new NotImplementedException();
}

/// <summary>Per-test harness for the submit/discard endpoint tests.</summary>
internal sealed class DiscardTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;

    public DiscardTestSubmitter Submitter { get; } = new();
    public FakeReviewEventBus Bus { get; } = new();
    public ConfigurableActivePrCache ActivePrCache { get; }

    public IServiceProvider Services => _derived.Services;

    private DiscardTestContext(bool subscribeAll)
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

    public static DiscardTestContext Create(bool subscribeAll = true) => new(subscribeAll);

    private IAppStateStore StateStore => _derived.Services.GetRequiredService<IAppStateStore>();

    public HttpClient CreateClient(string? tabId = "tab-test") =>
        _derived.CreateAuthenticatedClient(tabId);

    public async Task<HttpResponseMessage> Discard(int number, string owner = "o", string repo = "r",
        TimeSpan? timeout = null)
    {
        using var client = CreateClient();
        // Use a longer HttpClient timeout than the default (100s) when the test scenario needs it.
        if (timeout.HasValue)
            client.Timeout = timeout.Value + TimeSpan.FromSeconds(5);
        return await client.PostAsync(
            new Uri($"/api/pr/{owner}/{repo}/{number}/submit/discard", UriKind.Relative), null);
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

    public async Task SeedPendingReviewIdAsync(string owner, string repo, int number, string pendingReviewId)
    {
        var key = $"{owner}/{repo}/{number}";
        await StateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(key, out var s)) return state;
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
            {
                [key] = s with { PendingReviewId = pendingReviewId },
            };
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
