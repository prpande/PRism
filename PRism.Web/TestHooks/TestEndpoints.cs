using Microsoft.AspNetCore.Mvc;
using PRism.Core;

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
