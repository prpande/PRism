using Microsoft.AspNetCore.Mvc;
using PRism.Core;
using PRism.Core.Hosting;
using PRism.Core.State;

namespace PRism.Web.TestHooks;

// Spec § 5.10 + plan Task 47. Test-only endpoints that mutate FakeReviewService
// state mid-Playwright-run. The hard-guard on environment at registration time
// ensures these routes never exist in Production — verified by the negative
// test (TestEndpoints_NotRegisteredInProduction_404).
//
// Auth-flow note: SessionTokenMiddleware (PRism.Web/Middleware/) only enforces
// auth on /api/* paths. /test/* falls outside that prefix, so Playwright's
// page.request.post('/test/advance-head') succeeds without supplying the
// session header. The Origin / CSRF check is similarly /api/*-scoped.
internal static class TestEndpoints
{
    internal sealed record AdvanceHeadRequest(
        string NewHeadSha,
        IReadOnlyList<FakeReviewService.FileContentChange> FileChanges);

    internal sealed record SetCommitReachableRequest(string Sha, bool Reachable);

    public static IEndpointRouteBuilder MapTestEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var env = app.ServiceProvider.GetRequiredService<IHostEnvironment>();
        // Hard guard: never register these in Production. The "Test" env-name
        // pattern matches the existing `/test/boom` registration in Program.cs
        // and aligns with the plan-described security baseline.
        if (!env.IsEnvironment("Test")) return app;

        app.MapPost("/test/advance-head", (
            AdvanceHeadRequest req,
            IReviewService reviewService) =>
        {
            if (reviewService is not FakeReviewService fake)
                return Results.Problem(
                    "FakeReviewService is not registered; /test/advance-head requires the Test-environment service swap.",
                    statusCode: StatusCodes.Status500InternalServerError);
            if (string.IsNullOrEmpty(req.NewHeadSha))
                return Results.BadRequest(new { error = "new-head-sha-missing" });
            fake.AdvanceHead(req.NewHeadSha, req.FileChanges ?? Array.Empty<FakeReviewService.FileContentChange>());
            return Results.Ok(new { ok = true });
        });

        // Resets per-test state: in-memory FakeReviewService (head sha,
        // reachable shas, iterations, file content) AND the persisted
        // state.json drafts. Called from each S4 PR7 spec's beforeEach so
        // tests don't leak state into each other. The backend process is
        // long-running for the whole Playwright run, so without this hook
        // the inboxes/sessions accumulate across tests.
        app.MapPost("/test/reset", async (
            IReviewService reviewService,
            IAppStateStore stateStore) =>
        {
            if (reviewService is FakeReviewService fake)
            {
                fake.Reset();
            }
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

        app.MapPost("/test/set-commit-reachable", (
            SetCommitReachableRequest req,
            IReviewService reviewService) =>
        {
            if (reviewService is not FakeReviewService fake)
                return Results.Problem(
                    "FakeReviewService is not registered; /test/set-commit-reachable requires the Test-environment service swap.",
                    statusCode: StatusCodes.Status500InternalServerError);
            if (string.IsNullOrEmpty(req.Sha))
                return Results.BadRequest(new { error = "sha-missing" });
            fake.SetCommitReachable(req.Sha, req.Reachable);
            return Results.Ok(new { ok = true });
        });

        return app;
    }
}
