namespace PRism.AI.Contracts.Observability;

/// <summary>Outcome of a single AI seam invocation, recorded to the AI audit log.</summary>
public enum AiInteractionOutcome
{
    /// <summary>The provider was invoked and returned a result — data egressed to the provider.</summary>
    Ok,

    /// <summary>Served from the in-process cache; the provider was NOT invoked, so nothing egressed.</summary>
    CacheHit,

    /// <summary>The provider was invoked but failed — egress was attempted.</summary>
    ProviderError,

    /// <summary>The structured seam returned an all-medium fallback (real ranking failed after retry).
    /// Distinct from Ok so fallback rate = count(Fallback) / count(rank attempts) is computable (spec §13).</summary>
    Fallback,
}

/// <summary>One metadata-only audit record per AI seam invocation. <see cref="Component"/> names the
/// AI feature that triggered the call (e.g. <c>"summary"</c>) so the audit trail shows which feature
/// reached the provider. This record NEVER carries prompt or response content — those can contain PR
/// diffs and secrets; only sizes (char counts) and token/cost metadata are recorded.</summary>
/// <param name="Component">The triggering AI feature, e.g. <c>"summary"</c>.</param>
/// <param name="ProviderId">The provider id, e.g. <c>"claude-code"</c>.</param>
/// <param name="Model">The model id, when known.</param>
/// <param name="PrRef">The PR the interaction was about (canonical id).</param>
/// <param name="HeadSha">The PR head SHA the interaction was about, when known.</param>
/// <param name="Outcome">Whether the call hit the provider, was served from cache, or failed.</param>
/// <param name="Egressed"><c>true</c> only when the provider was invoked (a cache hit egresses nothing).</param>
/// <param name="LatencyMs">Provider round-trip in milliseconds; null on a cache hit.</param>
/// <param name="InputTokens">Prompt tokens reported by the provider; null unless <see cref="AiInteractionOutcome.Ok"/>.</param>
/// <param name="OutputTokens">Completion tokens reported by the provider; null unless <see cref="AiInteractionOutcome.Ok"/>.</param>
/// <param name="CacheReadInputTokens">Provider prompt-cache read tokens; null unless <see cref="AiInteractionOutcome.Ok"/>.</param>
/// <param name="EstimatedCostUsd">Provider-estimated cost; null unless <see cref="AiInteractionOutcome.Ok"/>.</param>
/// <param name="PromptChars">Characters of PR-derived prompt content sent; null on a cache hit.</param>
/// <param name="ResponseChars">Characters of model response received; null unless <see cref="AiInteractionOutcome.Ok"/>.</param>
/// <param name="ErrorType">Exception type name on <see cref="AiInteractionOutcome.ProviderError"/>; null otherwise.</param>
public sealed record AiInteractionRecord(
    string Component,
    string ProviderId,
    string? Model,
    string PrRef,
    string? HeadSha,
    AiInteractionOutcome Outcome,
    bool Egressed,
    long? LatencyMs = null,
    long? InputTokens = null,
    long? OutputTokens = null,
    long? CacheReadInputTokens = null,
    decimal? EstimatedCostUsd = null,
    int? PromptChars = null,
    int? ResponseChars = null,
    string? ErrorType = null);

/// <summary>Audit sink for AI interactions — one structured line per AI seam invocation. Implementations
/// MUST be non-fatal (a failed write must never propagate — an audit-log failure cannot be allowed to deny
/// the user a summary that was already computed) and MUST be safe to call concurrently.</summary>
public interface IAiInteractionLog
{
    /// <summary>Records one interaction. Never throws.</summary>
    void Record(AiInteractionRecord record);
}
