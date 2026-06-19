using FluentAssertions;
using PRism.AI.Contracts.Observability;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiUsageRollupStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-rollup-" + Guid.NewGuid().ToString("N"));

    private AiUsageRollupStore NewStore() => new(_dir, TimeProvider.System);

    private static AiInteractionLogReader.LogEntry Entry(
        string component, string prRef, AiInteractionOutcome outcome, bool egressed,
        long hour, long input = 0, decimal? cost = null) =>
        new(new DateTimeOffset(2026, 6, 19, (int)hour, 0, 0, TimeSpan.Zero),
            new AiInteractionRecord(component, "claude-code", "m", prRef, null, outcome, egressed,
                InputTokens: input == 0 ? null : input, EstimatedCostUsd: cost));

    [Fact]
    public void Fold_aggregates_into_one_bucket_per_hour_component_pr()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.01m));
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 50, cost: 0.02m));

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.InputTokens.Should().Be(150);
        bucket.EstimatedCostUsd.Should().Be(0.03m);
        bucket.ProviderCalls.Should().Be(2);
    }

    [Fact]
    public void Fold_separates_buckets_by_hour_and_by_pr()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 11, input: 100)); // diff hour
        store.Fold(Entry("summary", "o/r#2", AiInteractionOutcome.Ok, true, 10, input: 100)); // diff pr
        store.SnapshotBuckets().Should().HaveCount(3);
    }

    [Fact]
    public void ProviderCalls_counts_Ok_and_ProviderError_by_outcome_not_egressed()
    {
        // A fallback scenario: 2 Ok attempts + 1 Fallback, ALL Egressed:true. Counting by Egressed
        // would yield 3; counting by Outcome correctly yields 2 provider calls.
        var store = NewStore();
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.01m));
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.01m));
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Fallback, true, 10)); // synthetic

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.ProviderCalls.Should().Be(2);
        bucket.EstimatedCostUsd.Should().Be(0.02m); // fallback carries no cost
        bucket.CacheHits.Should().Be(0);
    }

    [Fact]
    public void ProviderError_is_a_provider_call_with_zero_cost_and_CacheHit_is_separate()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.ProviderError, true, 10));
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.CacheHit, false, 10));

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.ProviderCalls.Should().Be(1);
        bucket.CacheHits.Should().Be(1);
        bucket.EstimatedCostUsd.Should().Be(0m);
    }

    [Fact]
    public async Task Persist_then_Load_roundtrips_buckets_and_offset()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.05m));
        store.Advance(newOffset: 4096, sourceLength: 4096);
        await store.PersistAsync();

        var reloaded = NewStore();
        reloaded.Load();
        reloaded.TailOffset.Should().Be(4096);
        var bucket = reloaded.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.InputTokens.Should().Be(100);
        bucket.EstimatedCostUsd.Should().Be(0.05m);
    }

    [Fact]
    public void Load_on_missing_or_corrupt_file_yields_empty_store_at_offset_zero()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "usage-rollup.json"), "{ this is not valid json");
        var store = NewStore();
        store.Load();
        store.SnapshotBuckets().Should().BeEmpty();
        store.TailOffset.Should().Be(0);
    }

    [Fact]
    public void Reset_clears_buckets_and_offset()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        store.Advance(100, 100);
        store.Reset();
        store.SnapshotBuckets().Should().BeEmpty();
        store.TailOffset.Should().Be(0);
    }

    [Fact]
    public async Task IsDirty_is_set_by_Fold_and_cleared_by_Persist()
    {
        var store = NewStore();
        store.IsDirty.Should().BeFalse();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        store.IsDirty.Should().BeTrue();
        await store.PersistAsync();
        store.IsDirty.Should().BeFalse();
    }

    [Fact]
    public void Fold_suppresses_cost_for_Fallback_even_when_record_carries_cost()
    {
        var store = NewStore();
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100, cost: 0.02m));
        store.Fold(Entry("fileFocus", "o/r#1", AiInteractionOutcome.Fallback, true, 10, cost: 0.05m));

        var bucket = store.SnapshotBuckets().Should().ContainSingle().Subject;
        bucket.EstimatedCostUsd.Should().Be(0.02m); // Fallback's 0.05 must be excluded
        bucket.ProviderCalls.Should().Be(1);
    }

    [Fact]
    public async Task Reset_marks_IsDirty_true()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        await store.PersistAsync(); // clears dirty
        store.IsDirty.Should().BeFalse();
        store.Reset();
        store.IsDirty.Should().BeTrue();
    }

    [Fact]
    public async Task Advance_with_same_offset_and_sourceLength_does_not_set_IsDirty()
    {
        var store = NewStore();
        store.Fold(Entry("summary", "o/r#1", AiInteractionOutcome.Ok, true, 10, input: 100));
        await store.PersistAsync(); // clears dirty; stored offset = 0, sourceLength = 0 (never advanced)
        store.IsDirty.Should().BeFalse();
        store.Advance(0, 0); // same as currently stored — no-op
        store.IsDirty.Should().BeFalse();
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
