using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;

namespace PRism.Web.Endpoints;

internal static class CapabilitiesEndpoints
{
    public static IEndpointRouteBuilder MapCapabilities(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet("/api/capabilities", async (
            AiModeState state,
            AiCapabilityResolver resolver,
            ILlmAvailabilityProbe probe,
            CancellationToken ct) =>
        {
            var mode = state.Mode;
            // Probe ONLY in Live mode (Off/Preview never touch the provider). No cache in P0.
            var availability = mode == AiMode.Live
                ? await probe.ProbeAsync(ct).ConfigureAwait(false)
                : LlmAvailability.Ok;

            return Results.Ok(new
            {
                ai = resolver.Resolve(mode, availability),                  // FE-compat: the `ai` envelope + 9 keys
#pragma warning disable CA1308 // lowercase mode names (off|preview|live) are part of the wire contract surfaced to the renderer
                mode = mode.ToString().ToLowerInvariant(),                  // "off" | "preview" | "live"
#pragma warning restore CA1308
                disabledReason = AiCapabilityResolver.DisabledReason(mode, availability),  // length-capped at the trust boundary inside DisabledReason
            });
        });
        return app;
    }
}
