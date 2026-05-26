using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

internal static class SubmitInFlightEndpoint
{
    public static IEndpointRouteBuilder MapSubmitInFlight(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Cheap snapshot of "is any submit currently locked?" used by the Settings page
        // and the Replace-token flow (spec § 3.5). Backed by SubmitLockRegistry.AnyHeld()
        // which reads the held-set, not the never-evicting _locks dictionary.
        app.MapGet("/api/submit/in-flight", (SubmitLockRegistry registry) =>
        {
            var (held, prRef) = registry.AnyHeld();
            return Results.Ok(new SubmitInFlightResponse(held, prRef));
        });

        return app;
    }
}

internal sealed record SubmitInFlightResponse(bool InFlight, string? PrRef);
