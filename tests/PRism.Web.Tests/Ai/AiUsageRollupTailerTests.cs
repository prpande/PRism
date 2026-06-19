using FluentAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Observability;
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

    [Fact]
    public async Task StopAsync_after_Dispose_does_not_throw()
    {
        // Repro of the host-teardown race seen on CI: WebApplicationFactory disposes the
        // singleton (Dispose() → _cts.Dispose()) BEFORE Host.StopAsync() runs, so StopAsync's
        // _cts.CancelAsync() hit an already-disposed CancellationTokenSource and threw
        // ObjectDisposedException out of shutdown. StopAsync must tolerate a prior Dispose().
        var store = NewStore();
        var tailer = NewTailer(store);
        await tailer.StartAsync(default);
        tailer.Dispose();

        var act = async () => await tailer.StopAsync(default);
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task StopAsync_does_not_throw_when_the_final_flush_fails()
    {
        // Arrange: create a FILE at "occupied", then point the store's dir INSIDE that path
        // so Directory.CreateDirectory / the write throws IOException at persist time.
        var occupied = Path.Combine(_dir, "occupied");
        File.WriteAllText(occupied, "x");
        var store = new AiUsageRollupStore(Path.Combine(occupied, "rollup-dir"), TimeProvider.System);

        // Seed the store dirty so TickAsync will attempt a persist.
        store.Fold(new AiInteractionLogReader.LogEntry(
            new DateTimeOffset(2026, 6, 19, 10, 0, 0, TimeSpan.Zero),
            new PRism.AI.Contracts.Observability.AiInteractionRecord(
                "summary", "claude-code", "m", "o/r#1", null,
                AiInteractionOutcome.Ok, true, InputTokens: 100, EstimatedCostUsd: 0.01m)));
        store.IsDirty.Should().BeTrue();

        // The log path can be absent — TickAsync handles a missing file.
        var tailer = new AiUsageRollupTailer(
            store,
            Path.Combine(_dir, "absent.log"),
            TimeProvider.System,
            NullLogger<AiUsageRollupTailer>.Instance);
        // NOTE: no StartAsync — _loop is null, StopAsync goes straight to the final tick.

        // Act + assert: best-effort flush must never propagate the IOException out of StopAsync.
        var act = async () => await tailer.StopAsync(default);
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task StopAsync_does_not_throw_when_logging_the_flush_failure_throws()
    {
        // The #550 host-teardown race: the final flush fails AND the logger's sink (e.g. an
        // EventLog provider) is already disposed, so logging the failure throws — the framework
        // wraps it in an AggregateException. StopAsync must not let that escape shutdown. The
        // sibling test above uses NullLogger (never throws on Log), so it does NOT cover this.
        var occupied = Path.Combine(_dir, "occupied-throwlog");
        File.WriteAllText(occupied, "x");
        var store = new AiUsageRollupStore(Path.Combine(occupied, "rollup-dir"), TimeProvider.System);
        store.Fold(new AiInteractionLogReader.LogEntry(
            new DateTimeOffset(2026, 6, 19, 10, 0, 0, TimeSpan.Zero),
            new PRism.AI.Contracts.Observability.AiInteractionRecord(
                "summary", "claude-code", "m", "o/r#1", null,
                AiInteractionOutcome.Ok, true, InputTokens: 100, EstimatedCostUsd: 0.01m)));
        store.IsDirty.Should().BeTrue();

        var tailer = new AiUsageRollupTailer(
            store,
            Path.Combine(_dir, "absent.log"),
            TimeProvider.System,
            new ThrowOnLogLogger()); // logs throw, mimicking a disposed EventLog sink at teardown

        var act = async () => await tailer.StopAsync(default);
        await act.Should().NotThrowAsync();
    }

    // A logger whose every write throws — stands in for a logger provider (e.g. EventLog) that
    // the host has already disposed when StopAsync's catch block tries to log the flush failure.
    private sealed class ThrowOnLogLogger : ILogger<AiUsageRollupTailer>
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            throw new ObjectDisposedException("EventLogInternal");
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
