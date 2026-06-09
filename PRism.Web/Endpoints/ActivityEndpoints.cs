using PRism.Core.Activity;

namespace PRism.Web.Endpoints;

internal static class ActivityEndpoints
{
    public static IEndpointRouteBuilder MapActivity(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Dedicated, inbox-isolated feed. Always 200: failure surfaces via
        // Degraded.ReceivedEvents + empty Items (the provider never throws on a
        // degraded read). No server cache in P1 (lands in P2). Inherits the global
        // middleware pipeline (session-token gate) like every other /api/* route.
        app.MapGet("/api/activity", async (IActivityProvider provider, CancellationToken ct) =>
            Results.Ok(await provider.GetActivityAsync(ct).ConfigureAwait(false)));

        return app;
    }
}
