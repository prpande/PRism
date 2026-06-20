namespace PRism.Core.Config;

/// <summary>Egress-consent record (spec §5). A null <see cref="DisclosureVersion"/> means
/// "no consent recorded" — the predicate (DisclosureVersion == current && ProviderId == claude)
/// evaluates false on it. Persisted at <c>ui.ai.consent</c>.</summary>
public sealed record AiConsentConfig(
    string? ProviderId,
    string? DisclosureVersion,
    DateTimeOffset? AcknowledgedAt)
{
    /// <summary>The "no consent recorded" default.</summary>
    public static AiConsentConfig None { get; } = new(null, null, null);
}
