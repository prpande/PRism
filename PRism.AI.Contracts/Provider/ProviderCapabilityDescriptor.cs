using System.Collections.Generic;

namespace PRism.AI.Contracts.Provider;

/// <summary>One provider-supplied disabled state. <paramref name="DisplayLabel"/> is plain text,
/// length-capped at the wire boundary (§2.3 — a provider assembly is a runtime trust boundary;
/// never HTML/markdown).</summary>
public sealed record ProviderDisabledState(string ReasonCode, string DisplayLabel);

/// <summary>
/// The §2.3 minimal P0 provider capability descriptor. Only the two axes with a v2 consumer are
/// modeled: <see cref="DisabledStates"/> (P0 — the Settings → AI section, PR3) and
/// <see cref="SupportsStructuredOutput"/> (P2 — the parse-validate-retry harness). The cost,
/// auth-credential, prompt-caching, and model-identifier axes are deliberately NOT modeled until a
/// second provider lands (premature generalization to avoid; see §2.3 "Minimal P0 descriptor").
/// </summary>
public sealed record ProviderCapabilityDescriptor(
    IReadOnlyList<ProviderDisabledState> DisabledStates,
    bool SupportsStructuredOutput);
