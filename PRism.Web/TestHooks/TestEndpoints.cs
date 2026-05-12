using Microsoft.AspNetCore.Mvc;
using PRism.Core.State;

namespace PRism.Web.TestHooks;

// Spec § 5.10 + plan Task 47. Test-only endpoints that mutate the FakeReviewBackingStore
// scenario state mid-Playwright-run. The hard-guard on environment at registration time
// ensures these routes never exist in Production — verified by the negative test
// (TestEndpoints_NotRegisteredInProduction_404).
//
// The store is only in DI when PRISM_E2E_FAKE_REVIEW=1 (the fake-review swap in Program.cs);
// in a plain Test-env xUnit run these routes are still mapped but the store is absent, so
// each handler probes for it and returns a 500 Problem if it's missing.
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

    private static IResult StoreMissing(string route) => Results.Problem(
        $"FakeReviewBackingStore is not registered; {route} requires the Test-environment fake-review swap (PRISM_E2E_FAKE_REVIEW=1).",
        statusCode: StatusCodes.Status500InternalServerError);

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
        // reachable shas, iterations, file content) AND the persisted state.json
        // drafts. Called from each S4 PR7 spec's beforeEach so tests don't leak
        // state into each other. The backend process is long-running for the whole
        // Playwright run, so without this hook the inboxes/sessions accumulate.
        app.MapPost("/test/reset", async (IServiceProvider sp, IAppStateStore stateStore) =>
        {
            sp.GetService<FakeReviewBackingStore>()?.Reset();
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

        return app;
    }
}
