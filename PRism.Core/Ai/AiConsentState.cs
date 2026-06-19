using PRism.Core.Config;

namespace PRism.Core.Ai;

/// <summary>Mirrors <c>ui.ai.consent</c> for synchronous predicate reads (spec §5). Parallel to
/// <see cref="AiModeState"/>. Consent is valid only when a stored record matches the active provider
/// AND the current disclosure version.</summary>
public sealed class AiConsentState
{
    private volatile AiConsentConfig _consent = AiConsentConfig.None;

    /// <summary>Gets the current consent record.</summary>
    public AiConsentConfig Current => _consent;

    /// <summary>Replaces the stored consent record. A <see langword="null"/> argument resets to
    /// <see cref="AiConsentConfig.None"/>.</summary>
    public void Set(AiConsentConfig consent) => _consent = consent ?? AiConsentConfig.None;

    /// <summary>Returns <see langword="true"/> only when the stored record matches both
    /// <paramref name="providerId"/> and <paramref name="currentDisclosureVersion"/> exactly.</summary>
    public bool IsConsented(string providerId, string currentDisclosureVersion)
    {
        var c = _consent;
        return c.ProviderId == providerId && c.DisclosureVersion == currentDisclosureVersion;
    }
}
