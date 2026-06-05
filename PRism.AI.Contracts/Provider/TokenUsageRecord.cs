namespace PRism.AI.Contracts.Provider;

/// <summary>One LLM call's usage — budget VISIBILITY only. Deliberately carries no env, no prompt
/// text, no credential — only counts + the CLI's cost estimate.</summary>
public sealed record TokenUsageRecord(
    string Feature,
    string ProviderId,
    int InputTokens,
    int OutputTokens,
    int CacheReadInputTokens,
    decimal EstimatedCostUsd,
    bool IsRetry);
