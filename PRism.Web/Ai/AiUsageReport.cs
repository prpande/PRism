namespace PRism.Web.Ai;

/// <summary>Aggregated AI usage for a window, served by GET /api/ai/usage (§4.6). Cost is a
/// provider-estimated rate-card figure, NOT a literal charge (the provider is a subscription).</summary>
internal sealed record AiUsageReport(
    string Window,                       // echoes "24h" | "7d" | "30d" | "all"
    DateTimeOffset GeneratedAt,
    AiUsageTotals Totals,
    IReadOnlyList<AiUsageFeatureRow> ByFeature,
    IReadOnlyList<AiUsagePrRow> ByPr,    // top 20 by cost (+ "batch" always); see TotalPrCount
    int TotalPrCount,                    // total distinct PrRefs in window (for "+N more")
    AiCacheStats Cache,
    IReadOnlyList<AiUsageTrendBucket> Trend);

internal sealed record AiUsageTotals(
    long InputTokens, long OutputTokens, long CacheReadInputTokens, long CacheCreationInputTokens,
    long TotalTokens,                    // sum of all four kinds = total provider activity for the window
    decimal EstimatedCostUsd, int ProviderCalls, int CacheHits);

internal sealed record AiUsageFeatureRow(
    string Component, string DisplayName, long TotalTokens, decimal EstimatedCostUsd, int ProviderCalls);

internal sealed record AiUsagePrRow(
    string PrRef, string DisplayLabel, long TotalTokens, decimal EstimatedCostUsd, int ProviderCalls);

internal sealed record AiCacheStats(int CacheHits, int ProviderCalls, double HitRate);

internal sealed record AiUsageTrendBucket(
    DateTimeOffset BucketStart, string Granularity, decimal EstimatedCostUsd, long TotalTokens);
