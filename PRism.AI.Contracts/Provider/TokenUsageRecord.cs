namespace PRism.AI.Contracts.Provider;

/// <summary>One LLM call's usage — budget VISIBILITY only. Deliberately carries no env, no prompt
/// text, no credential — only counts + the CLI's cost estimate. <paramref name="RecordedAt"/> is the
/// write-time timestamp; <see cref="JsonlTokenUsageTracker"/> stamps it at record time when left unset,
/// keeping the append-only log self-contained (daily totals / rate windows need no out-of-band timing).</summary>
public sealed record TokenUsageRecord(
    string Feature,
    string ProviderId,
    int InputTokens,
    int OutputTokens,
    int CacheReadInputTokens,
    decimal EstimatedCostUsd,
    bool IsRetry,
    DateTimeOffset RecordedAt = default);
