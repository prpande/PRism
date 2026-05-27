using Microsoft.AspNetCore.Mvc;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Endpoints;
using PRism.Web.Submit;

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

    internal sealed record MarkPrViewedRequest(string Owner, string Repo, int Number, string TabId);

    internal sealed record EmitPrUpdatedRequest(
        string Owner,
        string Repo,
        int Number,
        bool HeadShaChanged,
        bool CommentCountChanged,
        string? NewHeadSha,
        int CommentCountDelta);

    internal sealed record ClearPrSessionRequest(string Owner, string Repo, int Number);

    // ----- /test/submit/* (plan Task 61) -----

    internal sealed record InjectSubmitFailureRequest(string MethodName, string? Message, bool AfterEffect = false);

    internal sealed record SetBeginDelayRequest(int DelayMs);

    internal sealed record SetFindOwnNullRequest(int Call);

    internal sealed record SeedPendingReviewRequest(
        string Owner, string Repo, int Number, string? CommitOid, IReadOnlyList<SeedThread>? Threads);

    internal sealed record SeedThread(
        string FilePath, int LineNumber, string? Side, string Body, bool IsResolved, IReadOnlyList<SeedReply>? Replies);

    internal sealed record SeedReply(string Body);

    // ----- /test/submit/hold + /test/submit/release-hold (S6 PR4) -----

    internal sealed record HoldSubmitLockRequest(string Owner, string Repo, int Number);

    // Single-slot holder for the e2e Replace-token-submit-in-flight spec. The test
    // hook lets a Playwright spec acquire a SubmitLockRegistry slot WITHOUT running
    // the real submit pipeline, so the AnyHeld() probe reports true and the
    // AuthSection Replace link renders aria-disabled with the prRef tooltip.
    //
    // Static field is acceptable for two reasons: (a) Test-env only — never registered
    // in Production; (b) single PoC user, single Playwright worker, no concurrency
    // pressure across specs. The Reset endpoint disposes it as a safety net so a
    // forgetful spec doesn't leak the hold into the next test.
    //
    // Publish/swap uses Interlocked.CompareExchange / Interlocked.Exchange (no lock):
    // pairs the release barrier of the publish with the acquire barrier of the read,
    // so a Volatile.Read pre-check on weak memory models observes the latest write.
    // Previous lock-only publish + Volatile.Read pre-check was a documented memory-
    // model race (Copilot iter-2 finding C7); CompareExchange also subsumes the
    // lost-race bookkeeping (only one caller can swap null → handle; the loser
    // disposes its just-acquired slot).
    private static SubmitLockHandle? s_heldHandle;

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
            // Re-seed the active-PR poll cache to the just-advanced head so a spec-
            // immediate POST /reload (or /submit) sees the new sha synchronously rather
            // than racing against the ~1s ActivePrPoller cadence. Symmetric to the same
            // pattern in /test/reset above (PR7 added that; PR0b adds this so the three
            // un-fixme'd S4 specs that exercise advanceHead → reload don't 409 on
            // stale-head before the poller catches up).
            sp.GetService<PRism.Core.PrDetail.IActivePrCache>()?.Update(
                FakeReviewBackingStore.Scenario,
                new PRism.Core.PrDetail.ActivePrSnapshot(store.CurrentHeadSha, null, DateTimeOffset.UtcNow));
            return Results.Ok(new { ok = true });
        });

        // S6 PR9 Task 9.1. Directly publishes ActivePrUpdated via the event bus so the
        // no-layout-shift spec can deterministically observe BannerRefresh rendering
        // without depending on the ActivePrPoller race (the poller compares against
        // IActivePrCache, which /test/advance-head pre-warms — so a typical
        // advance-head → wait-for-banner path never fires pr-updated because the
        // cache already matches the new sha). SseChannel.OnActivePrUpdated picks
        // this up and fans out as `event: pr-updated` to subscribed clients.
        app.MapPost("/test/emit-pr-updated", (EmitPrUpdatedRequest req, PRism.Core.Events.IReviewEventBus bus) =>
        {
            if (string.IsNullOrEmpty(req.Owner) || string.IsNullOrEmpty(req.Repo) || req.Number <= 0)
                return Results.BadRequest(new { error = "pr-ref-missing" });
            // Internal consistency — a typo'd test request that publishes a malformed event
            // would surface as an opaque test timeout downstream. Reject early instead.
            if (req.HeadShaChanged && string.IsNullOrEmpty(req.NewHeadSha))
                return Results.BadRequest(new { error = "new-head-sha-required-when-head-sha-changed" });
            if (req.CommentCountChanged != (req.CommentCountDelta != 0))
                return Results.BadRequest(new { error = "comment-count-flag-and-delta-must-agree" });
            bus.Publish(new PRism.Core.Events.ActivePrUpdated(
                new PrReference(req.Owner, req.Repo, req.Number),
                req.HeadShaChanged,
                req.CommentCountChanged,
                req.NewHeadSha,
                req.CommentCountDelta));
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
            // Release any leaked /test/submit/hold from a prior spec before resetting
            // store/submitter — otherwise the held lock survives across specs and the
            // next AnyHeld() probe still reports in-flight on a fresh fixture. Atomic
            // swap mirrors /test/submit/release-hold.
            var leaked = Interlocked.Exchange(ref s_heldHandle, null);
            if (leaked is not null)
            {
                await leaked.DisposeAsync().ConfigureAwait(false);
            }
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
            // Spec § 3 — same TabId allowlist as mark-viewed / reload. The test hook is its
            // own request contract (TabId arrives in the JSON body, not the header — Playwright
            // mocked-mode specs read the tab id off window.__prism_test_getTabId and pass it
            // explicitly), but the validation gate is identical so a typo here behaves the same
            // way it does for the user-facing endpoints.
            if (string.IsNullOrEmpty(req.TabId) || !PrDetailEndpoints.TabIdAllowlistRegex().IsMatch(req.TabId))
                return Results.BadRequest(new { error = "tab-id-missing-or-invalid" });
            var key = $"{req.Owner}/{req.Repo}/{req.Number}";
            var headSha = store.CurrentHeadSha;
            await stateStore.UpdateAsync(state =>
            {
                var session = state.Reviews.Sessions.GetValueOrDefault(key)
                    ?? PrDraftEndpoints.NewEmptySession();
                var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                var tabStamps = session.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
                tabStamps[req.TabId] = new TabStamp(headSha, DateTime.UtcNow);
                if (tabStamps.Count > 8)
                {
                    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
                    tabStamps.Remove(oldest);
                }
                sessions[key] = session with { TabStamps = tabStamps };
                return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
            }, CancellationToken.None).ConfigureAwait(false);
            return Results.Ok(new { ok = true, headSha });
        });

        // Nukes the PR's session in state.json (drafts, PendingReviewId, LastViewedHeadSha,
        // DraftSummary, DraftVerdict) without touching auth state, AND removes every subscriber
        // for this PR from ActivePrSubscriberRegistry so the ActivePrPoller stops ticking it
        // between specs. Required by the real-flow Playwright suite's resetSandboxFixture;
        // reusable elsewhere if a future fake-mode spec wants per-PR session reset.
        //
        // Unlike /test/reset, this endpoint deliberately does NOT touch FakeReviewBackingStore /
        // FakeReviewSubmitter / PrDetailLoader / IActivePrCache — those are not present in the
        // real-flow composition (PRISM_E2E_FAKE_REVIEW is OFF). The state.json wipe + subscriber-
        // registry mutation are the only two surfaces shared between real-flow and fake-flow
        // PoC sessions, and both are always wired into DI regardless of env-var gating.
        app.MapPost("/test/clear-pr-session", async (ClearPrSessionRequest req, IAppStateStore stateStore, ActivePrSubscriberRegistry registry) =>
        {
            if (string.IsNullOrEmpty(req.Owner) || string.IsNullOrEmpty(req.Repo))
                return Results.BadRequest(new { error = "owner-or-repo-missing" });

            var key = $"{req.Owner}/{req.Repo}/{req.Number}";
            var prRef = new PrReference(req.Owner, req.Repo, req.Number);

            await stateStore.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.ContainsKey(key)) return state;
                var sessions = state.Reviews.Sessions
                    .Where(kv => kv.Key != key)
                    .ToDictionary(kv => kv.Key, kv => kv.Value);
                return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
            }, CancellationToken.None).ConfigureAwait(false);

            // Subscriber-registry mutation is concurrent-dict; iterate snapshot and Remove each.
            // ActivePrPoller takes UniquePrRefs() at tick-start, so any Remove between ticks is
            // observed on the next tick — no shared lock needed across state-store and registry.
            //
            // SubscribersFor returns a materialized snapshot (Keys.ToList in
            // ActivePrSubscriberRegistry), not a lazy IEnumerable backed by the underlying
            // ConcurrentDictionary — otherwise the mid-iteration Remove either throws
            // InvalidOperationException or silently skips subscribers depending on the underlying
            // enumeration semantics, leaving the registry partially cleaned (exactly the race
            // this endpoint exists to close).
            //
            // No transactional atomicity between state-store and registry: if Remove throws here the
            // session is already cleared. Acceptable — this endpoint is test-fixture-only, and
            // resetSandboxFixture re-runs idempotently per spec.
            foreach (var subscriberId in registry.SubscribersFor(prRef))
            {
                registry.Remove(subscriberId, prRef);
            }

            return Results.NoContent();
        });

        // Flips the scenario PR's open/closed/merged state (PR5 bulk-discard surface).
        app.MapPost("/test/set-pr-state", (SetPrStateRequest req, IServiceProvider sp) =>
        {
            var store = sp.GetService<FakeReviewBackingStore>();
            if (store is null) return StoreMissing("/test/set-pr-state");
            if (string.IsNullOrEmpty(req.State))
                return Results.BadRequest(new { error = "state-missing" });
            try
            {
                store.SetPrState(req.State);
            }
            catch (ArgumentException ex)
            {
                // store.SetPrState throws for unknown states; surface as 400 with the offending value
                // so a typo in an E2E spec is obvious rather than landing as an opaque 500.
                return Results.BadRequest(new { error = "state-invalid", state = req.State, message = ex.Message });
            }
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

            // Validate each thread up-front so a malformed test request lands a 400 with a clear pointer
            // rather than a 500 from a downstream NRE on FilePath / LineNumber or a snapshot whose Side
            // doesn't match the GraphQL DiffSide contract.
            var threads = req.Threads ?? Array.Empty<SeedThread>();
            for (var ti = 0; ti < threads.Count; ti++)
            {
                var t = threads[ti];
                if (string.IsNullOrEmpty(t.FilePath))
                    return Results.BadRequest(new { error = "thread-file-path-missing", index = ti });
                if (t.LineNumber <= 0)
                    return Results.BadRequest(new { error = "thread-line-number-invalid", index = ti, lineNumber = t.LineNumber });
                if (t.Body is null)
                    return Results.BadRequest(new { error = "thread-body-missing", index = ti });
                if (!string.IsNullOrEmpty(t.Side) && t.Side is not ("LEFT" or "RIGHT"))
                    return Results.BadRequest(new { error = "thread-side-invalid", index = ti, side = t.Side });
            }

            var commitOid = string.IsNullOrEmpty(req.CommitOid) ? store.CurrentHeadSha : req.CommitOid;
            var prRef = new PrReference(req.Owner, req.Repo, req.Number);
            var review = new FakeReviewSubmitter.FakePendingReview(fake.NextId("PRR_"), commitOid, DateTimeOffset.UtcNow.AddMinutes(-3), "");
            var nowBase = DateTimeOffset.UtcNow.AddMinutes(-3);
            var i = 0;
            foreach (var t in threads)
            {
                var threadId = fake.NextId("PRRT_");
                var replies = (t.Replies ?? Array.Empty<SeedReply>())
                    .Select(r => new FakeReviewSubmitter.FakeComment(fake.NextId("PRRC_"), r.Body ?? ""))
                    .ToList();
                review.Threads.Add(new FakeReviewSubmitter.FakeThread(
                    threadId, t.FilePath, t.LineNumber, string.IsNullOrEmpty(t.Side) ? "RIGHT" : t.Side, commitOid,
                    Body: t.Body, IsResolved: t.IsResolved, Replies: replies, CreatedAt: nowBase.AddSeconds(i++)));
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

        // S6 PR4 — acquire a SubmitLockRegistry slot synthetically so the
        // Replace-token-submit-in-flight e2e spec can observe the aria-disabled
        // AuthSection link without spinning up the full submit pipeline. Does NOT
        // require FakeReviewSubmitter; SubmitLockRegistry is in DI regardless.
        // Single-slot: a second hold call without an intervening release returns 409.
        app.MapPost("/test/submit/hold", async (HoldSubmitLockRequest req, SubmitLockRegistry locks, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.Owner) || string.IsNullOrEmpty(req.Repo))
                return Results.BadRequest(new { error = "owner-or-repo-missing" });
            // Optimistic pre-check: paired with the Interlocked.CompareExchange publish
            // below (release/acquire barrier on both sides), Volatile.Read observes the
            // latest published write on weak memory models. Avoids paying TryAcquireAsync's
            // semaphore-acquire when the slot is obviously taken.
            if (Volatile.Read(ref s_heldHandle) is not null)
                return Results.Conflict(new { error = "already-held" });

            var prRef = new PrReference(req.Owner, req.Repo, req.Number);
            // Short timeout (3s) — the Volatile pre-check above catches the common
            // case. The only path that blocks here is cross-spec lock leakage where a
            // prior /test/submit/hold left the SemaphoreSlim acquired but s_heldHandle
            // was nulled by /test/reset. Surface that condition as a fast 408 with an
            // actionable message rather than a long opaque CI hang. Real submit
            // contention is out of scope for this hook (Test-env, workers:1).
            var handle = await locks.TryAcquireAsync(prRef, TimeSpan.FromSeconds(3), ct).ConfigureAwait(false);
            if (handle is null)
                return Results.Problem(
                    "Timed out acquiring SubmitLockRegistry slot — likely a cross-spec lock leak (prior /test/submit/hold not followed by /test/submit/release-hold).",
                    statusCode: StatusCodes.Status408RequestTimeout);

            // Atomic publish: only one caller can swap null → handle. The loser
            // disposes its just-acquired slot. Replaces the prior lock + Volatile.Read
            // pattern (Copilot iter-2 finding C7) and removes the lostRace bookkeeping.
            var prior = Interlocked.CompareExchange(ref s_heldHandle, handle, null);
            if (prior is not null)
            {
                // Another /test/submit/hold won the race between our pre-check and the
                // CAS. Release our just-acquired slot and return 409.
                await handle.DisposeAsync().ConfigureAwait(false);
                return Results.Conflict(new { error = "already-held" });
            }
            return Results.Ok(new { ok = true, prRef = prRef.ToString() });
        });

        app.MapPost("/test/submit/release-hold", async () =>
        {
            // Atomic swap: takes the currently-held handle (if any) and nulls the field
            // in one step. No lock needed; the read barrier matches the CompareExchange
            // publish in /test/submit/hold above.
            var held = Interlocked.Exchange(ref s_heldHandle, null);
            if (held is null) return Results.NoContent();
            await held.DisposeAsync().ConfigureAwait(false);
            return Results.NoContent();
        });

        return app;
    }
}
