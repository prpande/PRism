namespace PRism.AI.Contracts.Provider;

/// <summary>One LLM call's usage — budget VISIBILITY only. Deliberately carries no env, no prompt
/// text, no credential — only counts + the provider's cost estimate. <paramref name="CacheCreationInputTokens"/>
/// is the prompt-cache WRITE volume that dominates a cold call's input tokens; omitting it under-reports
/// input by orders of magnitude (#379). <paramref name="RecordedAt"/> is
/// the write-time timestamp; the <see cref="ITokenUsageTracker"/> implementation stamps it at record
/// time when left unset, keeping the append-only log self-contained (daily totals / rate windows need
/// no out-of-band timing).</summary>
public sealed record TokenUsageRecord(
    string Feature,
    string ProviderId,
    int InputTokens,
    int OutputTokens,
    int CacheReadInputTokens,
    int CacheCreationInputTokens,
    decimal EstimatedCostUsd,
    bool IsRetry,
    DateTimeOffset RecordedAt = default);
