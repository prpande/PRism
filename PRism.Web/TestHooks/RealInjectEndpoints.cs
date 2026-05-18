namespace PRism.Web.TestHooks;

// Test-only endpoint for arming RealTransportFailureInjector from a Playwright spec.
// Symmetric to TestEndpoints' /test/submit/inject-failure (fake-side equivalent).
//
// Self-gates inside the extension method on (Test env + PRISM_E2E_REAL_INJECT=1) — Program.cs
// can call MapRealInjectEndpoints() unconditionally without worrying about exposure in
// Production. Matches the pattern TestEndpoints.cs already uses.
internal static class RealInjectEndpoints
{
    internal sealed record InjectFailureRequest(string? GraphQLFieldName, bool AfterEffect = false, string? Message = null);

    public static IEndpointRouteBuilder MapRealInjectEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        var env = app.ServiceProvider.GetRequiredService<IHostEnvironment>();
        var realInjectEnabled = Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1";
        if (!env.IsEnvironment("Test") || !realInjectEnabled) return app;

        app.MapPost("/test/real-inject/inject-failure", (InjectFailureRequest req, RealTransportFailureInjector injector) =>
        {
            if (string.IsNullOrEmpty(req.GraphQLFieldName))
                return Results.BadRequest(new { error = "graphQLFieldName-missing" });

            injector.InjectFailure(req.GraphQLFieldName, new HttpRequestException(req.Message ?? "simulated transport failure"), req.AfterEffect);
            return Results.Ok(new { ok = true });
        });

        return app;
    }
}
