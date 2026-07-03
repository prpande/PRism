using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

// #566 Slice 1 — POST /api/pr/{owner}/{repo}/{number:int:min(1)}/{close|reopen|ready-for-review|convert-to-draft}
//
// Security gates (mirroring PrSubmitEndpoints.cs exactly — Step 0 source-read confirmed):
//  1. CSRF custom-header gate: X-PRism-Tab-Id must be present + pass the TabStamps § 3 allowlist.
//     On miss → 422 "tab-id-missing". Uses TabStamps.TryValidateTabId — do NOT reimplement the gate.
//  2. Subscribe gate: RequireSubscribed.Check(activePrCache, prRef, …) returns IResult? —
//     null = subscribed (proceed); non-null = 403 + code "unauthorized".
//     Inject IActivePrCache (not an invented ISubscriberRegistry).
//
// Route constraint :min(1): rejects 0 and negatives (e.g. /api/pr/o/r/-1/close → 404)
// before the writer and self-documents the PrReference domain invariant.
internal static class PrLifecycleEndpoints
{
    public static void MapPrLifecycleEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/close",
            (string owner, string repo, int number, HttpContext http,
             IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache,
                               static (w, r, c) => w.CloseAsync(r, c), writer, ct));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/reopen",
            (string owner, string repo, int number, HttpContext http,
             IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache,
                               static (w, r, c) => w.ReopenAsync(r, c), writer, ct));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/ready-for-review",
            (string owner, string repo, int number, HttpContext http,
             IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache,
                               static (w, r, c) => w.MarkReadyForReviewAsync(r, c), writer, ct));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/convert-to-draft",
            (string owner, string repo, int number, HttpContext http,
             IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache,
                               static (w, r, c) => w.ConvertToDraftAsync(r, c), writer, ct));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/merge",
            async (string owner, string repo, int number, HttpContext http,
                   IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
                   CancellationToken ct) =>
            {
                var prRef = new PrReference(owner, repo, number);

                if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before performing lifecycle actions.") is { } notSubscribed)
                    return notSubscribed;

                if (!TabStamps.TryValidateTabId(http.Request, out _))
                    return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);

                // ReadFromJsonAsync throws InvalidOperationException (NOT JsonException, → unhandled
                // 500) on a missing/wrong Content-Type; HttpJson.TryReadJsonAsync single-sources that
                // guard. A non-JSON content-type and a malformed body both collapse to a null value,
                // which the head-sha guard below maps to the same 400 "head-sha-required" a bodyless
                // request gets — so the read error kind is intentionally not inspected here.
                var req = (await HttpJson.TryReadJsonAsync<MergeRequest>(http.Request, ct).ConfigureAwait(false)).Value;

                // Mandatory head-SHA staleness guard (spec decision #4): never forward a merge with no sha.
                if (req is null || string.IsNullOrEmpty(req.HeadSha))
                    return Results.Json(new { code = "head-sha-required" }, statusCode: StatusCodes.Status400BadRequest);
                if (ParseMethod(req.Method) is not { } method)
                    return Results.Json(new { code = "invalid-merge-method" }, statusCode: StatusCodes.Status400BadRequest);

                var result = await writer.MergeAsync(prRef, method, req.HeadSha, ct).ConfigureAwait(false);
                if (result.Success)
                {
                    bus.Publish(new PrLifecycleChanged(prRef));
                    return Results.Ok();
                }
                var (code, status) = MapError(result.ErrorCode);
                return Results.Json(new { code }, statusCode: status);
            });
    }

    private static async Task<IResult> HandleAsync(
        string owner, string repo, int number,
        HttpContext http,
        IReviewEventBus bus,
        IActivePrCache activePrCache,
        Func<IPrLifecycleWriter, PrReference, CancellationToken, Task<PrLifecycleResult>> action,
        IPrLifecycleWriter writer,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);

        // ── Subscribe gate (mirrors PrSubmitEndpoints.cs:109-110 precisely) ──────────────────
        // RequireSubscribed.Check returns null when subscribed (proceed); returns a non-null IResult
        // (HTTP 403 + body { "code": "unauthorized" }) when not subscribed.
        if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before performing lifecycle actions.") is { } notSubscribed)
            return notSubscribed;

        // ── CSRF custom-header gate (shared TabStamps § 3 allowlist) ─────────────────────────
        if (!TabStamps.TryValidateTabId(http.Request, out _))
            return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);

        // ── Lifecycle write ───────────────────────────────────────────────────────────────────
        var result = await action(writer, prRef, ct).ConfigureAwait(false);
        if (result.Success)
        {
            // Publish PrLifecycleChanged so:
            //   - Task 5 (PrDetailLoader subscriber) evicts the snapshot cache
            //   - Task 6 (SseEventProjection) fans the event out to subscribed tabs
            bus.Publish(new PrLifecycleChanged(prRef));
            return Results.Ok();
        }

        var (code, status) = MapError(result.ErrorCode);
        // Writer already logged the GitHub response body server-side; client DTO carries only
        // the machine-readable code so the FE can render actionable copy without leaking details.
        return Results.Json(new { code }, statusCode: status);
    }

    // Ordinal, case-exact allowlist — NOT a JsonStringEnumConverter bind, which is permissive
    // (accepts "Merge", "1"); see stj-enum-converter-permissive. Returns null on an invalid value.
    private static MergeMethod? ParseMethod(string? raw) => raw switch
    {
        "merge"  => MergeMethod.Merge,
        "squash" => MergeMethod.Squash,
        "rebase" => MergeMethod.Rebase,
        _        => null,
    };

    private sealed record MergeRequest(string? Method, string? HeadSha);

    private static (string Code, int Status) MapError(PrLifecycleErrorCode code) => code switch
    {
        PrLifecycleErrorCode.TokenCannotWrite      => ("token-cannot-write",      StatusCodes.Status403Forbidden),
        PrLifecycleErrorCode.RepoRuleBlocked       => ("repo-rule-blocked",       StatusCodes.Status403Forbidden),
        PrLifecycleErrorCode.ReopenNotPossible     => ("reopen-not-possible",     StatusCodes.Status422UnprocessableEntity),
        PrLifecycleErrorCode.PlanUnsupportedDrafts => ("plan-unsupported-drafts", StatusCodes.Status422UnprocessableEntity),
        PrLifecycleErrorCode.RateLimited           => ("rate-limited",            StatusCodes.Status429TooManyRequests),
        PrLifecycleErrorCode.MergeNotMergeable     => ("merge-not-mergeable",     StatusCodes.Status422UnprocessableEntity),
        PrLifecycleErrorCode.MergeHeadChanged      => ("merge-head-changed",      StatusCodes.Status409Conflict),
        _                                          => ("generic",                 StatusCodes.Status502BadGateway),
    };
}
