using Microsoft.AspNetCore.Mvc;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Web.TestHooks;

// Spec § 5.10 + plan Tasks 47 / 61. Test-only endpoints that drive the FakeReviewBackingStore
// scenario state + the FakeReviewSubmitter pending-review state mid-Playwright-run. The hard-guard
// on environment at registration time ensures these routes never exist in Production — verified by
// the negative test (TestEndpoints_NotRegisteredInProduction_404).
//
// The store / submitter are only in DI when PRISM_E2E_FAKE_REVIEW=1 (the fake-review swap in
// Program.cs); in a plain Test-env xUnit run these routes are still mapped but the fakes are absent,
// so each handler probes for them and returns a 500 Problem if missing.
//
// Middleware-interaction note:
//   - SessionTokenMiddleware enforces session auth on /api/* paths only;
//     /test/* falls outside that prefix and is exempt from the cookie/header
//     check.
//   - OriginCheckMiddleware applies to every POST/PUT/PATCH/DELETE regardless
//     of path, so /test/* mutations DO need an Origin header (helpers in
//     frontend/e2e/helpers/s4-setup.ts supply Origin: http://localhost:5180
//     explicitly because page.request.post does not auto-add it the way
//     fetch from a page document does).
internal static class TestEndpoints
{
    internal sealed record AdvanceHeadRequest(
        string NewHeadSha,
        IReadOnlyList<FakeReviewBackingStore.FileContentChange> FileChanges);

    internal sealed record SetCommitReachableRequest(string Sha, bool Reachable);

    internal sealed record SetPrStateRequest(string State);

    internal sealed record MarkPrViewedRequest(string Owner, string Repo, int Number);

    // ----- /test/submit/* (plan Task 61) -----

    internal sealed record InjectSubmitFailureRequest(string MethodName, string? Message, bool AfterEffect = false);

    internal sealed record SetBeginDelayRequest(int DelayMs);

    internal sealed record SetFindOwnNullRequest(int Call);

    internal sealed record SeedPendingReviewRequest(
        string Owner, string Repo, int Number, string? CommitOid, IReadOnlyList<SeedThread>? Threads);

    internal sealed record SeedThread(
        string FilePath, int LineNumber, string? Side, string Body, bool IsResolved, IReadOnlyList<SeedReply>? Replies);

    internal sealed record SeedReply(string Body);

    private static IResult StoreMissing(string route) => Results.Problem(
        $"FakeReviewBackingStore is not registered; {route} requires the Test-environment fake-review swap (PRISM_E2E_FAKE_REVIEW=1).",
        statusCode: StatusCodes.Status500InternalServerError);

    private static IResult SubmitterMissing(string route) => Results.Problem(
        $"FakeReviewSubmitter is not registered; {route} requires the Test-environment fake-review swap (PRISM_E2E_FAKE_REVIEW=1).",
        statusCode: StatusCodes.Status500InternalServerError);

    private static FakeReviewSubmitter? AsFake(IServiceProvider sp) => sp.GetService<IReviewSubmitter>() as FakeReviewSubmitter;

    public static IEndpointRouteBuilder MapTestEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var env = app.ServiceProvider.GetRequiredService<IHostEnvironment>();
        // Hard guard: never register these in Production. The "Test" env-name
        // pattern matches the existing `/test/boom` registration in Program.cs
        // and aligns with the plan-described security baseline.
        if (!env.IsEnvironment("Test")) return app;

        app.MapPost("/test/advance-head", (AdvanceHeadRequest req, IServiceProvider sp) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/advance-head");
            if (string.IsNullOrEmpty(req.NewHeadSha))
                return Results.BadRequest(new { error = "new-head-sha-missing" });
            store.AdvanceHead(req.NewHeadSha, req.FileChanges ?? Array.Empty<FakeReviewBackingStore.FileContentChange>());
            return Results.Ok(new { ok = true });
        });

        // Resets per-test state: the in-memory FakeReviewBackingStore (head sha,
        // reachable shas, iterations, file content, PR state), the FakeReviewSubmitter
        // (pending reviews, injected failures, knobs, counters), the PrDetailLoader's
        // snapshot/diff cache (otherwise a CLOSED/MERGED or advanced-head detail cached
        // by a prior spec leaks into the next one — the cache keys on prRef@headSha and
        // store.Reset() rolls the head back, so a later spec re-using a head sha would
        // hit the stale snapshot), AND the persisted state.json drafts. Called from each
        // spec's beforeEach so tests don't leak state into each other. The backend
        // process is long-running for the whole Playwright run, so without this hook the
        // inboxes/sessions accumulate.
        app.MapPost("/test/reset", async (IServiceProvider sp, IAppStateStore stateStore) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/reset");
            store.Reset();
            AsFake(sp)?.Reset();
            sp.GetService<PrDetailLoader>()?.InvalidateAll();
            // Re-seed the active-PR poll cache to the (just-reset) head so the submit head-sha-drift
            // gate (PrSubmitEndpoints rule (f)) sees the fresh head immediately, rather than a stale
            // advanced-head snapshot a prior spec's /test/advance-head left there until the ~1s
            // poller cadence catches up.
            sp.GetService<PRism.Core.PrDetail.IActivePrCache>()?.Update(
                FakeReviewBackingStore.Scenario,
                new PRism.Core.PrDetail.ActivePrSnapshot(store.CurrentHeadSha, null, DateTimeOffset.UtcNow));
            // Force-wipe state.json by re-applying Default. The single overwrite
            // is the documented pattern; LoadAsync after the await sees the
            // fresh empty state because UpdateAsync holds the gate across the
            // load → transform → save → release sequence.
            await stateStore.UpdateAsync(
                _ => AppState.Default,
                CancellationToken.None).ConfigureAwait(false);
            var after = await stateStore.LoadAsync(CancellationToken.None).ConfigureAwait(false);
            return Results.Ok(new
            {
                ok = true,
                sessions = after.Reviews.Sessions.Count,
            });
        });

        app.MapPost("/test/set-commit-reachable", (SetCommitReachableRequest req, IServiceProvider sp) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/set-commit-reachable");
            if (string.IsNullOrEmpty(req.Sha))
                return Results.BadRequest(new { error = "sha-missing" });
            store.SetCommitReachable(req.Sha, req.Reachable);
            return Results.Ok(new { ok = true });
        });

        // Records "viewed this PR at the current head" on the session so the submit head-sha-drift
        // gate (PrSubmitEndpoints rule (f)) passes. The real frontend sets LastViewedHeadSha via the
        // demo's "click Reload" step (POST /reload); E2E specs that don't exercise a reload use this
        // hook instead. Creates the session if it doesn't exist yet.
        app.MapPost("/test/mark-pr-viewed", async (MarkPrViewedRequest req, IServiceProvider sp, IAppStateStore stateStore) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/mark-pr-viewed");
            if (string.IsNullOrEmpty(req.Owner) || string.IsNullOrEmpty(req.Repo))
                return Results.BadRequest(new { error = "owner-or-repo-missing" });
            var key = $"{req.Owner}/{req.Repo}/{req.Number}";
            var headSha = store.CurrentHeadSha;
            await stateStore.UpdateAsync(state =>
            {
                var session = state.Reviews.Sessions.GetValueOrDefault(key)
                    ?? new ReviewSessionState(null, null, null, null, new Dictionary<string, string>(),
                        new List<DraftComment>(), new List<DraftReply>(), null, null, DraftVerdictStatus.Draft);
                var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions[key] = session with { LastViewedHeadSha = headSha };
                return state with { Reviews = state.Reviews with { Sessions = sessions } };
            }, CancellationToken.None).ConfigureAwait(false);
            return Results.Ok(new { ok = true, headSha });
        });

        // Flips the scenario PR's open/closed/merged state (PR5 bulk-discard surface).
        app.MapPost("/test/set-pr-state", (SetPrStateRequest req, IServiceProvider sp) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/set-pr-state");
            if (string.IsNullOrEmpty(req.State))
                return Results.BadRequest(new { error = "state-missing" });
            store.SetPrState(req.State);
            return Results.Ok(new { ok = true, state = store.PrState });
        });

        // ----- /test/submit/* — drive the FakeReviewSubmitter (plan Task 61) -----

        // One-shot failure injection on a named IReviewSubmitter method. afterEffect=true makes the
        // method's side effect happen first, then it throws — the lost-response window.
        app.MapPost("/test/submit/inject-failure", (InjectSubmitFailureRequest req, IServiceProvider sp) =>
        {
            var fake = AsFake(sp);
            if (fake is null) return SubmitterMissing("/test/submit/inject-failure");
            if (string.IsNullOrEmpty(req.MethodName))
                return Results.BadRequest(new { error = "method-name-missing" });
            fake.InjectFailure(req.MethodName, new HttpRequestException(req.Message ?? "simulated submit-step failure"), req.AfterEffect);
            return Results.Ok(new { ok = true });
        });

        // Holds BeginPendingReviewAsync for delayMs so the per-PR submit lock test can race a 2nd tab.
        app.MapPost("/test/submit/set-begin-delay", (SetBeginDelayRequest req, IServiceProvider sp) =>
        {
            var fake = AsFake(sp);
            if (fake is null) return SubmitterMissing("/test/submit/set-begin-delay");
            fake.SetBeginDelay(req.DelayMs);
            return Results.Ok(new { ok = true });
        });

        // Makes FindOwnPendingReviewAsync return null from the Nth call onward (GitHub's reviews list lagging).
        app.MapPost("/test/submit/set-find-own-null-from-call", (SetFindOwnNullRequest req, IServiceProvider sp) =>
        {
            var fake = AsFake(sp);
            if (fake is null) return SubmitterMissing("/test/submit/set-find-own-null-from-call");
            fake.SetFindOwnReturnsNullFromCall(req.Call);
            return Results.Ok(new { ok = true });
        });

        // Pre-seeds a pending review on a PR (the "foreign" pending-review scenario — it's foreign
        // relative to the session's PendingReviewId, which the pipeline compares against). commitOid
        // defaults to the store's current head sha; thread OriginalCommitOid follows it (so the Resume
        // endpoint's AnchoredLineContent enrichment can fetch the file at that sha).
        app.MapPost("/test/submit/seed-pending-review", (SeedPendingReviewRequest req, IServiceProvider sp) =>
        {
            var fake = AsFake(sp);
            if (fake is null) return SubmitterMissing("/test/submit/seed-pending-review");
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/submit/seed-pending-review");
            if (string.IsNullOrEmpty(req.Owner) || string.IsNullOrEmpty(req.Repo))
                return Results.BadRequest(new { error = "owner-or-repo-missing" });

            var commitOid = string.IsNullOrEmpty(req.CommitOid) ? store.CurrentHeadSha : req.CommitOid;
            var prRef = new PrReference(req.Owner, req.Repo, req.Number);
            var review = new FakeReviewSubmitter.FakePendingReview(fake.NextId("PRR_"), commitOid, DateTimeOffset.UtcNow.AddMinutes(-3), "");
            var nowBase = DateTimeOffset.UtcNow.AddMinutes(-3);
            var i = 0;
            foreach (var t in req.Threads ?? Array.Empty<SeedThread>())
            {
                var threadId = fake.NextId("PRRT_");
                var replies = (t.Replies ?? Array.Empty<SeedReply>())
                    .Select(r => new FakeReviewSubmitter.FakeComment(fake.NextId("PRRC_"), r.Body ?? ""))
                    .ToList();
                review.Threads.Add(new FakeReviewSubmitter.FakeThread(
                    threadId, t.FilePath, t.LineNumber, string.IsNullOrEmpty(t.Side) ? "RIGHT" : t.Side, commitOid,
                    Body: t.Body ?? "", IsResolved: t.IsResolved, Replies: replies, CreatedAt: nowBase.AddSeconds(i++)));
            }
            fake.SeedPendingReview(prRef, review);
            return Results.Ok(new { ok = true, pullRequestReviewId = review.Id, commitOid, threadCount = review.Threads.Count });
        });

        // Snapshot of the FakeReviewSubmitter for assertions (no thread/reply bodies hidden — this is
        // a test hook, the threat-model scrubbing only applies to the SSE projection). Returns the PR's
        // pending review (or null) + global mutation counters.
        app.MapGet("/test/submit/inspect-pending-review", (string owner, string repo, int number, IServiceProvider sp) =>
        {
            var fake = AsFake(sp);
            if (fake is null) return SubmitterMissing("/test/submit/inspect-pending-review");
            return Results.Json(fake.Inspect(new PrReference(owner, repo, number)));
        });

        return app;
    }
}
