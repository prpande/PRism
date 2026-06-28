using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

using FluentAssertions;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Spec § 13 — POST /api/pr/{ref}/drafts/discard-all (closed/merged-PR bulk-discard).
public class PrDraftsDiscardAllEndpointTests
{
    private static readonly TimeSpan CourtesyWait = TimeSpan.FromSeconds(5);

    private static ReviewSessionState SessionWithDraftsAndPending(string? pendingReviewId = null) =>
        SubmitEndpointsTestContext.ValidSession() with
        {
            PendingReviewId = pendingReviewId,
            PendingReviewCommitOid = pendingReviewId is null ? null : "head1",
            DraftReplies = new List<DraftReply> { new("rep1", "PRRT_x", null, "reply", DraftStatus.Draft, false) },
        };

    [Fact]
    public async Task PostDiscardAll_clears_session_state_returns_200()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, SessionWithDraftsAndPending());
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/1/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = await ctx.LoadSessionAsync("o", "r", 1);
        session!.DraftComments.Should().BeEmpty();
        session.DraftReplies.Should().BeEmpty();
        session.DraftVerdict.Should().BeNull();
        session.PendingReviewId.Should().BeNull();
        session.PendingReviewCommitOid.Should().BeNull();
    }

    [Fact]
    public async Task PostDiscardAll_pending_review_set_fires_courtesy_delete()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 2, SessionWithDraftsAndPending(pendingReviewId: "PRR_del"));
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/2/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        // The courtesy delete is fire-and-forget (spec § 13.2 step 3) — wait for it to land.
        await TestPoll.UntilAsync(() => ctx.Submitter.DeletedPendingReviews.Contains("PRR_del"), CourtesyWait);
        ctx.Bus.Published.OfType<SubmitOrphanCleanupFailedBusEvent>().Should().BeEmpty();
    }

    [Fact]
    public async Task PostDiscardAll_courtesy_delete_failure_publishes_orphan_cleanup_failed_and_still_clears()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        ctx.Submitter.DeletePendingReviewException = new HttpRequestException("network");
        await ctx.SeedSessionAsync("o", "r", 3, SessionWithDraftsAndPending(pendingReviewId: "PRR_del"));
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/3/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);  // courtesy failure does not block — returns immediately
        var session = await ctx.LoadSessionAsync("o", "r", 3);
        session!.DraftComments.Should().BeEmpty();
        session.PendingReviewId.Should().BeNull();
        // The fire-and-forget courtesy delete fails asynchronously → submit-orphan-cleanup-failed published.
        await TestPoll.UntilAsync(() => ctx.Bus.Published.OfType<SubmitOrphanCleanupFailedBusEvent>().Any(), CourtesyWait);
        ctx.Bus.Published.OfType<SubmitOrphanCleanupFailedBusEvent>().Should().ContainSingle();
    }

    // #605 item A — /drafts/discard-all must take the per-PR submit lock (cancel + drain), like
    // /submit/discard, so it cannot wipe the session out from under a concurrent in-flight submit.
    [Fact]
    public async Task PostDiscardAll_serializes_against_an_in_flight_submit()
    {
        using var ctx = SubmitEndpointsTestContext.Create();
        // A long Begin delay keeps the submit pipeline holding the lock; the discard's RequestCancel
        // cancels that delay so the lock is released and discard can acquire it (the fix). Pre-fix,
        // discard ignores the lock and returns while the pipeline is still holding it.
        ctx.Submitter.BeginDelay = TimeSpan.FromSeconds(30);
        await ctx.SeedSessionAsync("o", "r", 50, SubmitEndpointsTestContext.ValidSession());

        using var submitClient = ctx.CreateClient(tabId: "tab-test");
        var submitResp = await submitClient.PostAsJsonAsync("/api/pr/o/r/50/submit", new { verdict = "comment" });
        submitResp.StatusCode.Should().Be(HttpStatusCode.OK, "submit must start and hold the lock");

        // Wait until the pipeline actually holds the submit lock before discarding.
        await TestPoll.UntilAsync(() => ctx.LockRegistry.AnyHeld().Held, TimeSpan.FromSeconds(5));

        using var discardClient = ctx.CreateClient();
        var resp = await discardClient.PostAsync(new Uri("/api/pr/o/r/50/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        // The fix cancels the in-flight pipeline, acquires the lock, clears, then releases it. So by
        // the time discard returns, no submit lock is held — and the in-flight submit was cancelled
        // (never finalized). Pre-fix, discard ignored the lock and returned while the 30s-delayed
        // pipeline was still holding it (AnyHeld would still be true) and FinalizeCalled could race.
        ctx.LockRegistry.AnyHeld().Held.Should().BeFalse("discard-all must serialise through the submit lock and release it");
        ctx.Submitter.FinalizeCalled.Should().BeFalse("the in-flight submit must have been cancelled, not finalized");

        var session = await ctx.LoadSessionAsync("o", "r", 50);
        session!.DraftComments.Should().BeEmpty();
        session.DraftReplies.Should().BeEmpty();
    }

    [Fact]
    public async Task DiscardAll_not_subscribed_returns_403()
    {
        using var ctx = DiscardAllUnsubscribedContext.Create();
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/o/r/99/drafts/discard-all", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("code").GetString().Should().Be("unauthorized");
    }
}

// ─── Minimal harness for the not-subscribed path ───────────────────────────────────────────────
// Mirrors SubmitEndpointsTestContext but substitutes ConfigurableActivePrCache(subscribeAll: false)
// so the IsSubscribed guard fires. No session seed is needed — the guard short-circuits first.
internal sealed class DiscardAllUnsubscribedContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;

    private DiscardAllUnsubscribedContext()
    {
        _base = new PRismWebApplicationFactory();
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new ConfigurableActivePrCache(subscribeAll: false));
        }));
        _ = _derived.Services; // Force server (and DataDir/state.json) creation.
    }

    public static DiscardAllUnsubscribedContext Create() => new();

    public HttpClient CreateClient() =>
        _derived.CreateAuthenticatedClient();

    public void Dispose()
    {
        _derived.Dispose();
        _base.Dispose();
    }
}
