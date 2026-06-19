using Bucket = PRism.Web.Ai.AiUsageRollupStore.UsageBucket;

namespace PRism.Web.Ai;

/// <summary>Pure projection of rollup buckets into an <see cref="AiUsageReport"/> for a window.
/// No I/O — trivially unit-testable (§4.4). Counts (ProviderCalls/CacheHits) are pre-aggregated in
/// the buckets by Outcome (§4.1); this layer only sums and pivots.</summary>
internal static class AiUsageAggregator
{
    private const string BatchRef = "batch";
    private const int ByPrCap = 20;

    private static readonly Dictionary<string, string> DisplayNames = new(StringComparer.Ordinal)
    {
        ["summary"] = "PR Summary",
        ["fileFocus"] = "File Focus",
        ["hunkAnnotations"] = "Hunk Annotations",
        ["inboxEnrichment"] = "Inbox Enrichment",
    };

    public static AiUsageReport Aggregate(
        IReadOnlyCollection<Bucket> buckets, string window, DateTimeOffset now)
    {
        var normalized = Normalize(window);
        var filtered = Filter(buckets, normalized, now);

        var totals = BuildTotals(filtered);
        var byFeature = BuildByFeature(filtered);
        var (byPr, totalPrCount) = BuildByPr(filtered);
        var cache = new AiCacheStats(totals.CacheHits, totals.ProviderCalls,
            totals.CacheHits + totals.ProviderCalls == 0
                ? 0
                : (double)totals.CacheHits / (totals.CacheHits + totals.ProviderCalls));
        var trend = BuildTrend(filtered, normalized);

        return new AiUsageReport(normalized, now, totals, byFeature, byPr, totalPrCount, cache, trend);
    }

    private static string Normalize(string? window)
    {
        if (string.Equals(window, "24h", StringComparison.OrdinalIgnoreCase)) return "24h";
        if (string.Equals(window, "30d", StringComparison.OrdinalIgnoreCase)) return "30d";
        if (string.Equals(window, "all", StringComparison.OrdinalIgnoreCase)) return "all";
        return "7d";
    }

    private static List<Bucket> Filter(IReadOnlyCollection<Bucket> buckets, string window, DateTimeOffset now)
    {
        DateTimeOffset? cutoff = window switch
        {
            "24h" => now.AddHours(-24),
            "7d" => now.AddDays(-7),
            "30d" => now.AddDays(-30),
            _ => null, // all
        };
        if (cutoff is null) return buckets.ToList();
        var cutoffHour = cutoff.Value.ToUnixTimeSeconds() / 3600;
        return buckets.Where(b => b.HourEpoch >= cutoffHour).ToList();
    }

    private static long Tokens(Bucket b) =>
        b.InputTokens + b.OutputTokens + b.CacheReadInputTokens + b.CacheCreationInputTokens;

    private static AiUsageTotals BuildTotals(List<Bucket> b) => new(
        InputTokens: b.Sum(x => x.InputTokens),
        OutputTokens: b.Sum(x => x.OutputTokens),
        CacheReadInputTokens: b.Sum(x => x.CacheReadInputTokens),
        CacheCreationInputTokens: b.Sum(x => x.CacheCreationInputTokens),
        TotalTokens: b.Sum(Tokens),
        EstimatedCostUsd: b.Sum(x => x.EstimatedCostUsd),
        ProviderCalls: b.Sum(x => x.ProviderCalls),
        CacheHits: b.Sum(x => x.CacheHits));

    private static List<AiUsageFeatureRow> BuildByFeature(List<Bucket> b) =>
        b.GroupBy(x => x.Component, StringComparer.Ordinal)
         .Select(g => new AiUsageFeatureRow(
             g.Key,
             DisplayNames.TryGetValue(g.Key, out var name) ? name : g.Key,
             g.Sum(Tokens), g.Sum(x => x.EstimatedCostUsd), g.Sum(x => x.ProviderCalls)))
         .OrderByDescending(r => r.EstimatedCostUsd)
         .ToList();

    private static (List<AiUsagePrRow> Rows, int Total) BuildByPr(List<Bucket> b)
    {
        var grouped = b.GroupBy(x => x.PrRef, StringComparer.Ordinal)
            .Select(g => new AiUsagePrRow(
                g.Key,
                g.Key == BatchRef ? "Inbox (batched)" : g.Key,
                g.Sum(Tokens), g.Sum(x => x.EstimatedCostUsd), g.Sum(x => x.ProviderCalls)))
            .OrderByDescending(r => r.EstimatedCostUsd)
            .ToList();

        var total = grouped.Count;
        var top = grouped.Take(ByPrCap).ToList();
        // Always include the "batch" row even if the cap excluded it.
        if (top.All(r => r.PrRef != BatchRef))
        {
            var batch = grouped.FirstOrDefault(r => r.PrRef == BatchRef);
            if (batch is not null) top.Add(batch);
        }
        return (top, total);
    }

    private static List<AiUsageTrendBucket> BuildTrend(List<Bucket> b, string window)
    {
        if (b.Count == 0) return new List<AiUsageTrendBucket>();

        var granularity = window switch
        {
            "24h" => "hour",
            "all" => SpanExceeds90Days(b) ? "week" : "day",
            _ => "day",
        };

        IEnumerable<IGrouping<DateTimeOffset, Bucket>> groups = granularity switch
        {
            "hour" => b.GroupBy(x => HourStart(x.HourEpoch)),
            "week" => b.GroupBy(x => WeekStart(HourStart(x.HourEpoch))),
            _ => b.GroupBy(x => new DateTimeOffset(
                DateTime.SpecifyKind(HourStart(x.HourEpoch).UtcDateTime.Date, DateTimeKind.Utc), TimeSpan.Zero)), // day
        };

        return groups
            .Select(g => new AiUsageTrendBucket(g.Key, granularity, g.Sum(x => x.EstimatedCostUsd), g.Sum(Tokens)))
            .OrderBy(t => t.BucketStart)
            .ToList();
    }

    private static bool SpanExceeds90Days(List<Bucket> b)
    {
        var min = b.Min(x => x.HourEpoch);
        var max = b.Max(x => x.HourEpoch);
        return (max - min) / 24 > 90; // hours → days
    }

    private static DateTimeOffset HourStart(long hourEpoch) =>
        DateTimeOffset.FromUnixTimeSeconds(hourEpoch * 3600);

    private static DateTimeOffset WeekStart(DateTimeOffset when)
    {
        var date = when.UtcDateTime.Date;
        var delta = (7 + (int)date.DayOfWeek - (int)DayOfWeek.Monday) % 7;
        return new DateTimeOffset(DateTime.SpecifyKind(date.AddDays(-delta), DateTimeKind.Utc), TimeSpan.Zero);
    }
}
