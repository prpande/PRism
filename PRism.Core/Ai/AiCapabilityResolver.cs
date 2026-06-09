using System;
using System.Collections.Generic;
using PRism.AI.Contracts.Capabilities;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;

namespace PRism.Core.Ai;

/// <summary>
/// Projects (mode, availability, consented) → the 9 per-flag <see cref="AiCapabilities"/>
/// (replacing the AllOn/AllOff binary). Off → all false; Preview → all true (Placeholder covers
/// every seam); Live → a flag is true only when a real impl is registered for that seam AND the
/// provider is available AND the user has consented to the current disclosure version. In P0 the
/// live-seam dictionary is empty, so Live yields all-false + the probe's reason.
/// </summary>
/// <remarks>
/// Holds the SAME live-seam dictionary instance that <see cref="AiSeamSelector"/> resolves against
/// (shared by reference in composition), and reads it at call time — NOT a construction-time snapshot.
/// This keeps the resolver and selector in lockstep: when P1 registers the first real impl into the
/// shared dictionary, both the capability flag and the resolved seam light up together. A snapshot
/// (e.g. <c>realSeams.Keys.ToHashSet()</c>) would freeze P0's empty set and silently desync from the
/// selector (PR #250 review).
/// <para>Reason-code precedence (§ T6): a probe-unavailable reason beats consent-required so the FE
/// always sees the most actionable failure first.</para>
/// </remarks>
public sealed class AiCapabilityResolver
{
    private readonly IReadOnlyDictionary<Type, object> _liveSeams;

    public AiCapabilityResolver(IReadOnlyDictionary<Type, object> liveSeams)
    {
        ArgumentNullException.ThrowIfNull(liveSeams);
        _liveSeams = liveSeams;
    }

    public AiCapabilities Resolve(AiMode mode, LlmAvailability liveAvailability, bool consented)
    {
        ArgumentNullException.ThrowIfNull(liveAvailability);

        bool Capable(Type seam) => mode switch
        {
            AiMode.Off => false,
            AiMode.Preview => true,
            AiMode.Live => _liveSeams.ContainsKey(seam) && liveAvailability.Available && consented,
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
    /// unavailable (probe-unavailable reason wins over consent-required), "consent-required" when Live
    /// is available but the user has not consented to the current disclosure version, else "none"
    /// (Off/Preview are not "disabled" — they are deliberate modes). The provider-supplied ReasonCode
    /// is length-capped HERE at the trust boundary (§2.3) so every caller — not just the capabilities
    /// endpoint — gets a bounded, plain-text string.</summary>
    public static string DisabledReason(AiMode mode, LlmAvailability liveAvailability, bool consented)
    {
        ArgumentNullException.ThrowIfNull(liveAvailability);
        if (mode != AiMode.Live) return "none";
        if (!liveAvailability.Available) return Cap(liveAvailability.ReasonCode);  // provider reason wins
        return consented ? "none" : "consent-required";
    }

    private static string Cap(string s) => s.Length <= 200 ? s : s[..200];
}
