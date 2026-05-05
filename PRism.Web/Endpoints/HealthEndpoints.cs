using System.Reflection;

namespace PRism.Web.Endpoints;

internal static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealth(this IEndpointRouteBuilder app, string dataDir, int port)
    {
        ArgumentNullException.ThrowIfNull(app);
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        app.MapGet("/api/health", () => new
        {
            port,
            version,
            dataDir,
        });
        return app;
    }
}
