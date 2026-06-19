using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PRism.Web.Ai;

/// <summary>Periodic byte-offset tailer that folds new <c>ai-interactions.log</c> lines into
/// <see cref="AiUsageRollupStore"/>. Fully decoupled from the AI record path — nothing it does can
/// fail an AI call. Cursor is a byte offset (no clock dependency, no same-timestamp ties); single
/// writer (this timer). Startup does NOT block on backfill: the first tick runs in the loop. Bounds
/// dashboard staleness to ≤ the tick interval (§4.2).</summary>
internal sealed partial class AiUsageRollupTailer : IHostedService, IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);

    private readonly AiUsageRollupStore _store;
    private readonly string _logPath;
    private readonly TimeProvider _clock;
    private readonly ILogger<AiUsageRollupTailer> _logger;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    public AiUsageRollupTailer(AiUsageRollupStore store, string logPath, TimeProvider clock,
        ILogger<AiUsageRollupTailer> logger)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentException.ThrowIfNullOrEmpty(logPath);
        _store = store;
        _logPath = logPath;
        _clock = clock;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _store.Load();
        _loop = Task.Run(() => RunLoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask; // do NOT await the loop — backfill happens in the background
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        // Host teardown can dispose this singleton (Dispose() → _cts.Dispose()) BEFORE StopAsync
        // runs — WebApplicationFactory does exactly this. Dispose() already cancelled the loop, so
        // there is nothing left to stop or flush: return cleanly rather than crash shutdown (the
        // class contract below). Without this guard CancelAsync throws ObjectDisposedException.
        try { await _cts.CancelAsync().ConfigureAwait(false); }
        catch (ObjectDisposedException) { return; }
        if (_loop is not null)
        {
            try { await _loop.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        try { await TickAsync(cancellationToken).ConfigureAwait(false); } // best-effort final flush; must never crash shutdown
        catch (OperationCanceledException) { }
#pragma warning disable CA1031 // a shutdown-flush failure is logged, never propagated out of StopAsync
        catch (Exception ex) { LogTickFailedSafely(ex); }
#pragma warning restore CA1031
    }

    // Logging a tick failure must itself never throw. During host teardown the logger's sink
    // (e.g. an EventLog provider) can already be disposed — the framework then wraps the write
    // fault in an AggregateException, which would propagate out of StopAsync/the loop and fail
    // shutdown (#550). The tick failure is already best-effort, so dropping its one log line on
    // a disposed sink is acceptable.
    private void LogTickFailedSafely(Exception ex)
    {
#pragma warning disable CA1031 // logging-sink faults during teardown have nothing safe to fall back to
        try { Log.TickFailed(_logger, ex); }
        catch { /* logger sink disposed during teardown */ }
#pragma warning restore CA1031
    }

    private async Task RunLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(Interval, _clock);
        do
        {
            try { await TickAsync(ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { throw; }
#pragma warning disable CA1031 // never let the loop die on a transient IO error; observe + retry next tick
            catch (Exception ex) { LogTickFailedSafely(ex); }
#pragma warning restore CA1031
        }
        while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }

    internal async Task TickAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var fileLength = File.Exists(_logPath) ? new FileInfo(_logPath).Length : 0;

        // Truncation / shrink (or future rotation): file shorter than where we last read → rebuild.
        if (fileLength < _store.TailOffset)
        {
            Log.Truncated(_logger, _store.TailOffset, fileLength);
            _store.Reset();
        }

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(_logPath, _store.TailOffset);
        foreach (var entry in entries) _store.Fold(entry);
        _store.Advance(newOffset, fileLength);

        if (_store.IsDirty) await _store.PersistAsync(ct).ConfigureAwait(false); // persist offset + buckets atomically, only when changed
    }

    public void Dispose()
    {
        // Synchronous path: CancelAsync is not usable from Dispose; the sync .Cancel() is acceptable
        // here since IDisposable callers cannot await. CA1849 suppressed at the call site.
#pragma warning disable CA1849 // sync Cancel is the only option from a void Dispose
        _cts.Cancel();
#pragma warning restore CA1849
        _cts.Dispose();
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning,
            Message = "ai-usage rollup: tick failed (non-fatal; will retry next interval)")]
        internal static partial void TickFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning,
            Message = "ai-usage rollup: log shrank (offset {Offset} > length {Length}); rebuilding from 0")]
        internal static partial void Truncated(ILogger logger, long offset, long length);
    }
}
