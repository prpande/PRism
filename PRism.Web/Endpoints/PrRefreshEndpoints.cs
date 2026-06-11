using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

internal static class PrRefreshEndpoints
{
    public static IEndpointRouteBuilder MapPrRefreshEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // #344: proactive manual refresh of the PR-detail view. Forces a fresh GitHub re-read
        // (bypasses the (prRef, headSha, generation) snapshot cache) so an unchanged head SHA
        // still re-pulls. Empty 200 on success; the frontend then reloads via GET /api/pr/{ref}.
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/refresh",
            async (string owner, string repo, int number, PrDetailLoader loader, CancellationToken ct) =>
            {
                var prRef = new PrReference(owner, repo, number);
                var before = loader.TryGetCachedSnapshot(prRef);   // reference identity of committed snapshot
                try
                {
                    var snap = await loader.RefreshAsync(prRef, ct).ConfigureAwait(false);
                    return snap is null
                        ? Results.Problem(type: "/pr/not-found", statusCode: 404)
                        : Results.Ok();                            // fresh snapshot committed (incl. no-change)
                }
                catch (OperationCanceledException) { throw; }      // client aborted; not an error
#pragma warning disable CA1031 // intentional honest-completion catch-all; mirrors InboxEndpoints /refresh
                catch (Exception)
                {
                    // Honest-completion (semantic C, same as /api/inbox/refresh). ANY throw lands
                    // BEFORE RefreshAsync's overwrite, so this call did not commit. Return 200 iff
                    // a concurrent poller/GET advanced the committed view past `before`; else 503.
                    // The check lives in the generic catch (not a typed RateLimitExceededException
                    // catch) because GetPrDetail/GetTimeline surface a GitHub 429 as a plain
                    // HttpRequestException — the typed exception is inbox-only (spec § 3.2).
                    return ReferenceEquals(loader.TryGetCachedSnapshot(prRef), before)
                        ? Results.Problem(title: "PR refresh failed", statusCode: 503, type: "/pr/refresh-failed")
                        : Results.Ok();
                }
#pragma warning restore CA1031
            });

        return app;
    }
}
