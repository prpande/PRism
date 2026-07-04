using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

// #571 — POST /api/pr/{owner}/{repo}/{number:int:min(1)}/thread/{resolve|unresolve}
//
// Mirrors PrLifecycleEndpoints.HandleAsync gate order exactly (subscribe -> tab-id -> body),
// then inserts a new gate 3 unique to this endpoint: the threadId in the request body must
// belong to THIS PR's detail snapshot before the mutation runs (spec §5.4 ownership binding).
// Without gate 3 a caller subscribed to PR A could resolve/unresolve a thread belonging to
// PR B simply by guessing/observing its opaque GitHub node id.
internal static class PrReviewThreadEndpoints
{
    public static void MapPrReviewThreadEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/thread/resolve",
            (string owner, string repo, int number, HttpContext http,
             IReviewThreadWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             PrDetailLoader loader, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, loader,
                               static (w, r, id, c) => w.ResolveAsync(r, id, c), writer, ct));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/thread/unresolve",
            (string owner, string repo, int number, HttpContext http,
             IReviewThreadWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             PrDetailLoader loader, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, loader,
                               static (w, r, id, c) => w.UnresolveAsync(r, id, c), writer, ct));
    }

    // PrDetailLoader is the concrete type (no IPrDetailLoader — single impl); other endpoints
    // inject it directly (PrDetailEndpoints.cs).
    private static async Task<IResult> HandleAsync(
        string owner, string repo, int number, HttpContext http,
        IReviewEventBus bus, IActivePrCache activePrCache, PrDetailLoader loader,
        Func<IReviewThreadWriter, PrReference, string, CancellationToken, Task<ReviewThreadResult>> action,
        IReviewThreadWriter writer, CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);

        // Gate 1 — subscribe (verbatim from PrLifecycleEndpoints).
        if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before resolving threads.") is { } notSubscribed)
            return notSubscribed;

        // Gate 2 — tab-id CSRF (verbatim).
        if (!TabStamps.TryValidateTabId(http.Request, out _))
            return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);

        // Body.
        var req = (await HttpJson.TryReadJsonAsync<ResolveRequest>(http.Request, ct).ConfigureAwait(false)).Value;
        if (req is null || string.IsNullOrEmpty(req.ThreadId))
            return Results.Json(new { code = "thread-id-required" }, statusCode: StatusCodes.Status400BadRequest);

        // Gate 3 — ownership binding (spec §5.4): the threadId must belong to THIS PR's snapshot.
        // Hot path is the in-memory cache; re-hydrate via LoadAsync only if a background evict cleared
        // it (verbatim the PrDetailEndpoints.cs hybrid) so a legitimately-evicted snapshot does NOT
        // spurious-404. ReviewComments lives on snapshot.Detail (PrDetailSnapshot = Detail/HeadSha/Gen).
        var snapshot = loader.TryGetCachedSnapshot(prRef) ?? await loader.LoadAsync(prRef, ct).ConfigureAwait(false);
        if (snapshot is null || !snapshot.Detail.ReviewComments.Any(t => t.ThreadId == req.ThreadId))
            return Results.Json(new { code = "thread-not-found" }, statusCode: StatusCodes.Status404NotFound);

        var result = await action(writer, prRef, req.ThreadId, ct).ConfigureAwait(false);
        if (result.Success)
        {
            bus.Publish(new ReviewThreadResolutionChanged(prRef));
            return Results.Ok();
        }
        var (code, status) = MapError(result.ErrorCode);
        return Results.Json(new { code }, statusCode: status);
    }

    private sealed record ResolveRequest(string? ThreadId);

    private static (string Code, int Status) MapError(ReviewThreadErrorCode code) => code switch
    {
        ReviewThreadErrorCode.TokenCannotWrite => ("token-cannot-write", StatusCodes.Status403Forbidden),
        ReviewThreadErrorCode.ThreadNotFound   => ("thread-not-found",   StatusCodes.Status404NotFound),
        ReviewThreadErrorCode.RateLimited      => ("rate-limited",       StatusCodes.Status429TooManyRequests),
        _                                      => ("generic",            StatusCodes.Status502BadGateway),
    };
}
