using FluentAssertions;
using PRism.Web.Ai;
using Xunit;
using Bucket = PRism.Web.Ai.AiUsageRollupStore.UsageBucket;

namespace PRism.Web.Tests.Ai;

public sealed class AiUsageAggregatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 6, 19, 12, 0, 0, TimeSpan.Zero);

    private static long HourEpoch(DateTimeOffset when) => when.ToUnixTimeSeconds() / 3600;

    private static Bucket B(string component, string prRef, DateTimeOffset hour,
        long input = 0, decimal cost = 0m, int providerCalls = 0, int cacheHits = 0) =>
        new(HourEpoch(hour), component, prRef, input, 0, 0, 0, cost, providerCalls, cacheHits);

    [Fact]
    public void Aggregate_24h_excludes_buckets_older_than_24h()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 100, cost: 0.05m, providerCalls: 1),
            B("summary", "o/r#2", Now.AddHours(-30), input: 999, cost: 9.99m, providerCalls: 1), // outside 24h
        };
        var report = AiUsageAggregator.Aggregate(buckets, "24h", Now);

        report.Window.Should().Be("24h");
        report.Totals.TotalTokens.Should().Be(100);
        report.Totals.EstimatedCostUsd.Should().Be(0.05m);
        report.Totals.ProviderCalls.Should().Be(1);
    }

    [Fact]
    public void Aggregate_all_window_includes_everything()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 100, cost: 0.05m, providerCalls: 1),
            B("summary", "o/r#2", Now.AddDays(-200), input: 50, cost: 0.02m, providerCalls: 1),
        };
        var report = AiUsageAggregator.Aggregate(buckets, "all", Now);
        report.Totals.TotalTokens.Should().Be(150);
    }

    [Fact]
    public void Aggregate_byFeature_maps_display_names_and_sorts_by_cost_desc()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1),
            B("fileFocus", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.50m, providerCalls: 1),
        };
        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);

        report.ByFeature[0].Component.Should().Be("fileFocus");
        report.ByFeature[0].DisplayName.Should().Be("File Focus");
        report.ByFeature[1].DisplayName.Should().Be("PR Summary");
    }

    [Fact]
    public void Aggregate_unknown_component_passes_through_with_raw_name()
    {
        var buckets = new[] { B("futureSeam", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1) };
        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);
        report.ByFeature.Should().ContainSingle().Which.DisplayName.Should().Be("futureSeam");
    }

    [Fact]
    public void Aggregate_byPr_caps_top_20_but_always_includes_batch_and_reports_total_count()
    {
        var buckets = new List<Bucket>();
        for (var i = 0; i < 25; i++)
            buckets.Add(B("summary", $"o/r#{i}", Now.AddHours(-1), input: 10, cost: (i + 1) * 0.01m, providerCalls: 1));
        // A cheap batch row that would fall outside the top-20-by-cost cut.
        buckets.Add(B("inboxEnrichment", "batch", Now.AddHours(-1), input: 1, cost: 0.0001m, providerCalls: 1));

        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);

        report.TotalPrCount.Should().Be(26);
        report.ByPr.Should().HaveCount(21); // top 20 + the always-included batch
        report.ByPr.Should().Contain(r => r.PrRef == "batch");
        report.ByPr.Single(r => r.PrRef == "batch").DisplayLabel.Should().Be("Inbox (batched)");
    }

    [Fact]
    public void Aggregate_cache_hitRate_is_zero_when_no_activity()
    {
        var report = AiUsageAggregator.Aggregate(Array.Empty<Bucket>(), "7d", Now);
        report.Cache.HitRate.Should().Be(0);
        report.Totals.TotalTokens.Should().Be(0);
        report.ByFeature.Should().BeEmpty();
        report.ByPr.Should().BeEmpty();
    }

    [Fact]
    public void Aggregate_cache_hitRate_uses_hits_over_hits_plus_provider_calls()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), providerCalls: 3, cacheHits: 1),
        };
        var report = AiUsageAggregator.Aggregate(buckets, "7d", Now);
        report.Cache.CacheHits.Should().Be(1);
        report.Cache.ProviderCalls.Should().Be(3);
        report.Cache.HitRate.Should().BeApproximately(0.25, 0.0001); // 1 / (1 + 3)
    }

    [Fact]
    public void Aggregate_trend_is_hourly_for_24h_and_daily_for_7d()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1),
            B("summary", "o/r#1", Now.AddHours(-2), input: 10, cost: 0.01m, providerCalls: 1),
        };
        AiUsageAggregator.Aggregate(buckets, "24h", Now).Trend.Should().NotBeEmpty().And.OnlyContain(t => t.Granularity == "hour");
        AiUsageAggregator.Aggregate(buckets, "7d", Now).Trend.Should().NotBeEmpty().And.OnlyContain(t => t.Granularity == "day");
    }

    [Fact]
    public void Aggregate_trend_is_weekly_for_all_when_span_exceeds_90_days()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddDays(-120), input: 10, cost: 0.01m, providerCalls: 1),
            B("summary", "o/r#1", Now.AddHours(-1), input: 10, cost: 0.01m, providerCalls: 1),
        };
        AiUsageAggregator.Aggregate(buckets, "all", Now).Trend.Should().NotBeEmpty().And.OnlyContain(t => t.Granularity == "week");
    }

    [Fact]
    public void Aggregate_normalize_is_case_insensitive()
    {
        AiUsageAggregator.Aggregate(Array.Empty<Bucket>(), "24H", Now).Window.Should().Be("24h");
        AiUsageAggregator.Aggregate(Array.Empty<Bucket>(), "ALL", Now).Window.Should().Be("all");
    }

    [Fact]
    public void Aggregate_30d_excludes_buckets_older_than_30_days()
    {
        var buckets = new[]
        {
            B("summary", "o/r#1", Now.AddDays(-29), input: 200, cost: 0.10m, providerCalls: 2),
            B("summary", "o/r#2", Now.AddDays(-31), input: 999, cost: 9.99m, providerCalls: 5), // outside 30d
        };
        var report = AiUsageAggregator.Aggregate(buckets, "30d", Now);

        report.Window.Should().Be("30d");
        report.Totals.TotalTokens.Should().Be(200);
        report.Totals.EstimatedCostUsd.Should().Be(0.10m);
        report.Totals.ProviderCalls.Should().Be(2);
    }
}
