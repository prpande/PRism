using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiUsageRollupTailerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-tailer-" + Guid.NewGuid().ToString("N"));
    private string LogPath => Path.Combine(_dir, "ai-interactions.log");

    public AiUsageRollupTailerTests() => Directory.CreateDirectory(_dir);

    private AiUsageRollupStore NewStore() => new(_dir, TimeProvider.System);
    private AiUsageRollupTailer NewTailer(AiUsageRollupStore store) =>
        new(store, LogPath, TimeProvider.System, NullLogger<AiUsageRollupTailer>.Instance);

    private static string OkLine(string ts, string component, string prRef, long input) =>
        $$"""{"timestamp":"{{ts}}","component":"{{component}}","providerId":"claude-code","prRef":"{{prRef}}","outcome":"ok","egressed":true,"inputTokens":{{input}},"estimatedCostUsd":0.01}""";

    private void WriteLog(params string[] lines) =>
        File.WriteAllText(LogPath, string.Join(Environment.NewLine, lines) + Environment.NewLine);

    [Fact]
    public async Task Tick_folds_new_lines_and_advances_offset()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store = NewStore();
        var tailer = NewTailer(store);

        await tailer.TickAsync(default);

        store.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(100);
        store.TailOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public async Task Tick_after_crash_before_persist_does_not_double_count()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store1 = NewStore();
        await NewTailer(store1).TickAsync(default); // folds + persists

        // Simulate a crash: in-memory state lost. A fresh store loads from the PERSISTED offset.
        var store2 = NewStore();
        store2.Load();
        await NewTailer(store2).TickAsync(default); // re-tick over the same (already-consumed) file

        store2.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(100); // not 200
    }

    [Fact]
    public async Task Tick_rebuilds_from_zero_when_file_shrinks_below_offset()
    {
        WriteLog(
            OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100),
            OkLine("2026-06-19T11:00:00.0000000+00:00", "summary", "o/r#2", 200));
        var store = NewStore();
        await NewTailer(store).TickAsync(default);
        store.TailOffset.Should().BeGreaterThan(0);

        // Truncate the log to a single, shorter line — file length < persisted offset.
        WriteLog(OkLine("2026-06-19T12:00:00.0000000+00:00", "summary", "o/r#3", 50));
        await NewTailer(store).TickAsync(default);

        store.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(50); // rebuilt
    }

    [Fact]
    public async Task Tick_does_not_persist_when_nothing_new()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store = NewStore();
        await NewTailer(store).TickAsync(default); // persists once
        var rollupPath = Path.Combine(_dir, "usage-rollup.json");
        var firstWrite = File.GetLastWriteTimeUtc(rollupPath);

        await NewTailer(store).TickAsync(default); // nothing new → must not rewrite
        store.IsDirty.Should().BeFalse();
        File.GetLastWriteTimeUtc(rollupPath).Should().Be(firstWrite);
    }

    [Fact]
    public async Task StopAsync_does_a_final_tick()
    {
        WriteLog(OkLine("2026-06-19T10:00:00.0000000+00:00", "summary", "o/r#1", 100));
        var store = NewStore();
        var tailer = NewTailer(store);
        await tailer.StartAsync(default); // loads; does not block on backfill
        await tailer.StopAsync(default);  // final tick folds the line

        store.SnapshotBuckets().Should().ContainSingle().Which.InputTokens.Should().Be(100);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
