using PRism.AI.Contracts.Capabilities;
using PRism.Core.Ai;

namespace PRism.Web.Endpoints;

internal static class CapabilitiesEndpoints
{
    public static IEndpointRouteBuilder MapCapabilities(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet("/api/capabilities", (AiPreviewState state) => new
        {
            ai = state.IsOn ? AiCapabilities.AllOn : AiCapabilities.AllOff,
        });
        return app;
    }
}
