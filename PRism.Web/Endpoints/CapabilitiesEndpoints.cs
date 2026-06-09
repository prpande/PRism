using Microsoft.Extensions.Logging;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;

namespace PRism.Web.Endpoints;

internal static partial class CapabilitiesEndpoints
{
    // Marker type so the route delegate resolves a category-specific ILogger
    // (mirrors AuthEndpoints.Category) without colliding with the Program-level category.
    private sealed class Category { }

    public static IEndpointRouteBuilder MapCapabilities(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet("/api/capabilities", async (
            AiModeState state,
            AiCapabilityResolver resolver,
            ILlmAvailabilityProbe probe,
            AiConsentState consent,
            ILogger<Category> log,
            CancellationToken ct) =>
        {
            var mode = state.Mode;
            // Probe ONLY in Live mode (Off/Preview never touch the provider). No cache in P0.
            // P1 (before Live becomes FE-reachable): add the two-tier cache per §6/KTD-4 — useCapabilities
            // refetches on every window focus, so an uncached Live probe is a ~10s shell-out per refocus.
            // Probe failures are mapped to a deterministic disabled reason HERE (not deferred): Live is
            // reachable in P0 via a config edit (ui.ai.mode="live"), so an unguarded probe throw would
            // 500 this public endpoint instead of returning a stable disabledReason (PR #250 review).
            LlmAvailability availability;
            if (mode == AiMode.Live)
            {
                try
                {
                    availability = await probe.ProbeAsync(ct).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // deliberate broad catch at a public trust boundary: any probe failure (spawn, IO, runner) maps to a stable reason, never a 500. Cancellation is excluded so request aborts still propagate.
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Map to a deterministic reason, but LOG the swallowed cause — otherwise a real
                    // Live-mode probe failure is invisible while the endpoint keeps returning 200 (PR #250 review).
                    Log.ProbeFailed(log, ex);
                    availability = LlmAvailability.Unavailable("probe-failed");
                }
#pragma warning restore CA1031
            }
            else
            {
                availability = LlmAvailability.Ok;
            }

            var consented = consent.IsConsented(AiProviderIds.Claude, AiDisclosure.CurrentVersion);
            return Results.Ok(new
            {
                ai = resolver.Resolve(mode, availability, consented),       // FE-compat: the `ai` envelope + 9 keys
#pragma warning disable CA1308 // lowercase mode names (off|preview|live) are part of the wire contract surfaced to the renderer
                mode = mode.ToString().ToLowerInvariant(),                  // "off" | "preview" | "live"
#pragma warning restore CA1308
                disabledReason = AiCapabilityResolver.DisabledReason(mode, availability, consented),  // length-capped at the trust boundary inside DisabledReason
            });
        });
        return app;
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "/api/capabilities: Live provider probe failed; returning disabledReason=probe-failed")]
        internal static partial void ProbeFailed(ILogger logger, Exception ex);
    }
}
