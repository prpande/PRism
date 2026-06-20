namespace PRism.AI.Contracts.Provider;

/// <summary>Completion result. <paramref name="CacheReadInputTokens"/> is the P1b cost-lever
/// measurement (0 = no cross-process cache hit). <paramref name="CacheCreationInputTokens"/> is the
/// prompt-cache WRITE volume that dominates a cold call's input tokens (#379). <paramref name="EstimatedCostUsd"/>
/// is the provider-reported per-call estimate (client-side, not authoritative).</summary>
public sealed record LlmResult(
    string Text,
    int InputTokens,
    int OutputTokens,
    int CacheReadInputTokens,
    int CacheCreationInputTokens,
    decimal EstimatedCostUsd);
