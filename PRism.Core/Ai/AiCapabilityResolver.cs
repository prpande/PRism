using System;
using System.Collections.Generic;
using PRism.AI.Contracts.Capabilities;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;

namespace PRism.Core.Ai;

/// <summary>
/// Projects (mode, availability) → the 9 per-flag <see cref="AiCapabilities"/> (replacing the
/// AllOn/AllOff binary). Off → all false; Preview → all true (Placeholder covers every seam);
/// Live → a flag is true only when a real impl is registered for that seam AND the provider is
/// available. In P0 the live-seam set is empty, so Live yields all-false + the probe's reason.
/// </summary>
public sealed class AiCapabilityResolver
{
    private readonly IReadOnlySet<Type> _liveCapableSeams;

    public AiCapabilityResolver(IReadOnlySet<Type> liveCapableSeams) => _liveCapableSeams = liveCapableSeams;

    public AiCapabilities Resolve(AiMode mode, LlmAvailability liveAvailability)
    {
        ArgumentNullException.ThrowIfNull(liveAvailability);

        bool Capable(Type seam) => mode switch
        {
            AiMode.Off => false,
            AiMode.Preview => true,
            AiMode.Live => _liveCapableSeams.Contains(seam) && liveAvailability.Available,
            _ => false,
        };

        return new AiCapabilities(
            Summary: Capable(typeof(IPrSummarizer)),
            FileFocus: Capable(typeof(IFileFocusRanker)),
            HunkAnnotations: Capable(typeof(IHunkAnnotator)),
            PreSubmitValidators: Capable(typeof(IPreSubmitValidator)),
            ComposerAssist: Capable(typeof(IComposerAssistant)),
            DraftSuggestions: Capable(typeof(IDraftSuggester)),
            DraftReconciliation: Capable(typeof(IDraftReconciliator)),
            InboxEnrichment: Capable(typeof(IInboxItemEnricher)),
            InboxRanking: Capable(typeof(IInboxRanker)));
    }

    /// <summary>The active disabled reason for the wire: the provider's ReasonCode when Live is
    /// unavailable, else "none" (Off/Preview are not "disabled" — they are deliberate modes). The
    /// provider-supplied ReasonCode is length-capped HERE at the trust boundary (§2.3) so every caller —
    /// not just the capabilities endpoint — gets a bounded, plain-text string.</summary>
    public static string DisabledReason(AiMode mode, LlmAvailability liveAvailability)
    {
        ArgumentNullException.ThrowIfNull(liveAvailability);
        return mode == AiMode.Live && !liveAvailability.Available ? Cap(liveAvailability.ReasonCode) : "none";
    }

    private static string Cap(string s) => s.Length <= 200 ? s : s[..200];
}
