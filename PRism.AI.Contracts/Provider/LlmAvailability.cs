namespace PRism.AI.Contracts.Provider;

/// <summary>
/// Provider-neutral availability result. <paramref name="ReasonCode"/> is a PROVIDER-SUPPLIED
/// string (the concrete provider owns its vocabulary) — "none" when available. <paramref
/// name="ReasonMessage"/> is optional human-readable detail. The per-flag mapping from reason
/// codes to UI guidance lands in a later PR.
/// </summary>
public sealed record LlmAvailability(bool Available, string ReasonCode, string? ReasonMessage)
{
    /// <summary>The available state (reason code "none").</summary>
    public static LlmAvailability Ok { get; } = new(true, "none", null);

    /// <summary>An unavailable state with a provider-supplied reason code and optional message.</summary>
    public static LlmAvailability Unavailable(string reasonCode, string? message = null) =>
        new(false, reasonCode, message);
}
