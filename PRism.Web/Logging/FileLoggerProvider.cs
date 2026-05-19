using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

using Microsoft.Extensions.Logging;

namespace PRism.Web.Logging;

// File-backed ILoggerProvider. Owns a bounded Channel<FileLogEvent>, a background writer task
// that drains it, daily-rolling FileStream open with FileShare.Read, retention sweep at startup,
// and a synthetic session-start marker as the first event in every file.
//
// Lifecycle:
//   - constructor starts the writer task.
//   - DisposeAsync sets _shutdownStarted=1, completes the channel writer, awaits the drain
//     with a 2-second budget, writes the session-end summary, flushes + closes the stream.
//   - DI container calls DisposeAsync on registered IAsyncDisposable singletons after all
//     IHostedService instances have stopped — so the drain happens after every other
//     logging consumer has gone quiet.
//
// Self-diagnostic discipline: the writer task NEVER calls ILogger. All write failures /
// retention failures / parser failures go to Console.Error (rate-limited to one stderr line
// per session per failure class) and to a counter that lands in the session-end summary.
internal sealed class FileLoggerProvider : ILoggerProvider, IAsyncDisposable
{
    internal const int RetentionDays = 14;
    internal const int ChannelCapacity = 1024;

    private static readonly Regex DailyLogFileName =
        new(@"^prism-(\d{4}-\d{2}-\d{2})\.log$", RegexOptions.Compiled);

    private readonly string _logsDir;
    private readonly Func<DateTimeOffset> _now;   // clock seam — overridable from tests via internal ctor.
                                                  // Used for FileLogEvent.Timestamp AND for date-rollover
                                                  // checks. DateTimeOffset (not DateTime) so the seam
                                                  // covers both the per-event UTC timestamp and the
                                                  // local-date rollover boundary.
    private readonly Channel<FileLogEvent> _channel;
    private readonly CancellationTokenSource _stoppingCts = new();
    private readonly Task _writerTask;

    private FileStream? _currentStream;
    private DateOnly _currentFileDate;

    private int _shutdownStarted;
    private long _droppedDueToBackpressure;
    private long _droppedDuringShutdown;
    private long _writeFailureCount;
    private long _retentionFailureCount;
    private long _parserFailureCount;

    // Internal counter accessors for tests (assembly is InternalsVisibleTo PRism.Web.Tests).
    internal long DroppedDueToBackpressure => Interlocked.Read(ref _droppedDueToBackpressure);
    internal long DroppedDuringShutdown => Interlocked.Read(ref _droppedDuringShutdown);
    internal long WriteFailureCount => Interlocked.Read(ref _writeFailureCount);
    internal long ParserFailureCount => Interlocked.Read(ref _parserFailureCount);

    // Internal seam: FileLogger asks the parent for "now" so the clock seam is honored for
    // FileLogEvent.Timestamp. Production uses real-machine time; tests override via the
    // internal ctor.
    internal DateTimeOffset Now() => _now();

    // Internal seam: FileLogger reports template-substitution failures so the provider can
    // increment the parser-failure counter and stderr-rate-limit the diagnostic.
    internal void OnTemplateSubstitutionFailure()
    {
        if (Interlocked.Increment(ref _parserFailureCount) == 1)
            Console.Error.WriteLine("PRism FileLogger template substitution failed; subsequent failures suppressed for this session.");
    }

    public FileLoggerProvider(string logsDir) : this(logsDir, () => DateTimeOffset.Now) { }

    // Test-only ctor accepting a clock seam.
    internal FileLoggerProvider(string logsDir, Func<DateTimeOffset> now)
    {
        ArgumentException.ThrowIfNullOrEmpty(logsDir);
        ArgumentNullException.ThrowIfNull(now);
        _logsDir = logsDir;
        _now = now;
        // FullMode = Wait so TryWrite returns FALSE on full (caller increments _droppedDueToBackpressure).
        // DropWrite would silently drop and return TRUE — the drop counter would be dead code. Wait
        // still has non-blocking semantics for TryWrite (it returns immediately on full); the writer
        // task is single-reader and drains promptly.
        _channel = Channel.CreateBounded<FileLogEvent>(new BoundedChannelOptions(ChannelCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
        });
        _writerTask = Task.Run(() => RunWriterAsync(_stoppingCts.Token));
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(categoryName, this);

    internal void TryEnqueue(FileLogEvent evt)
    {
        if (_channel.Writer.TryWrite(evt)) return;

        if (Volatile.Read(ref _shutdownStarted) == 1)
            Interlocked.Increment(ref _droppedDuringShutdown);
        else
            Interlocked.Increment(ref _droppedDueToBackpressure);
    }

    // Sync-bridge to DisposeAsync. .GetAwaiter().GetResult() on an awaiting async method
    // would deadlock if the caller has a SynchronizationContext (ASP.NET request thread, test
    // runners with custom contexts). The DI container correctly calls DisposeAsync directly
    // at host teardown, so this path is unlikely to fire in production — but .Wait(timeout)
    // is the safe shape for any direct Dispose() call.
    void IDisposable.Dispose() => DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(3));

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _shutdownStarted, 1) == 1) return;  // idempotent

        _channel.Writer.Complete();

        try
        {
            await _writerTask.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            await _stoppingCts.CancelAsync().ConfigureAwait(false);
#pragma warning disable CA1031 // Best-effort cleanup; never throw from dispose.
            try { await _writerTask.ConfigureAwait(false); } catch (Exception) { /* swallow */ }
#pragma warning restore CA1031
        }
#pragma warning disable CA1031 // Best-effort cleanup; never throw from dispose.
        catch (Exception) { /* swallow */ }
#pragma warning restore CA1031

#pragma warning disable CA1031 // Best-effort cleanup; never throw from dispose.
        try
        {
            if (_currentStream is not null)
                await _currentStream.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception) { /* swallow */ }
#pragma warning restore CA1031
        _stoppingCts.Dispose();
    }

    private async Task RunWriterAsync(CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(_logsDir);
            RunRetentionSweep();
            _currentFileDate = DateOnly.FromDateTime(_now().LocalDateTime);

            // Spec § 7 extension: OpenAppendStream can throw IOException when the daily file
            // is held by another writer (ADV2-4 second-process case). Without this try/catch
            // the exception would propagate to the outer fatal-stderr catch and the writer
            // task would exit silently with no counter increment — the operator loses the
            // open-failure signal. Route to _writeFailureCount with the same one-stderr-per-
            // session rate-limit pattern as WriteEventAsync, then exit cleanly so the finally
            // block (which sees _currentStream == null and short-circuits) runs.
            try
            {
                _currentStream = OpenAppendStream(_currentFileDate);
            }
#pragma warning disable CA1031 // Open-failure: route to counter + stderr, exit gracefully.
            catch (Exception ex)
            {
                if (Interlocked.Increment(ref _writeFailureCount) == 1)
                    await Console.Error.WriteLineAsync($"PRism FileLogger open-stream failed: {ex.Message}").ConfigureAwait(false);
                return;  // writer task exits; finally still runs; EmitSessionEndSummaryAsync sees null stream.
            }
#pragma warning restore CA1031

            await EmitSessionStartLineAsync().ConfigureAwait(false);

            await foreach (var evt in _channel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                await WriteEventAsync(evt).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Expected on cancellation-driven shutdown — drain whatever's left non-blockingly.
            while (_channel.Reader.TryRead(out var evt))
                await WriteEventAsync(evt).ConfigureAwait(false);
        }
#pragma warning disable CA1031 // Writer task must never throw; failures route to counters.
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"PRism FileLogger writer task fatal: {ex.Message}").ConfigureAwait(false);
        }
#pragma warning restore CA1031
        finally
        {
            await EmitSessionEndSummaryAsync().ConfigureAwait(false);
#pragma warning disable CA1031 // Best-effort flush; never throw from finally.
            try
            {
                if (_currentStream is not null)
                    await _currentStream.FlushAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception) { /* swallow */ }
#pragma warning restore CA1031
        }
    }

    private async Task WriteEventAsync(FileLogEvent evt)
    {
        var today = DateOnly.FromDateTime(evt.Timestamp.LocalDateTime);
        if (today != _currentFileDate)
        {
#pragma warning disable CA1031 // Best-effort rotate; never throw.
            try { if (_currentStream is not null) await _currentStream.FlushAsync(CancellationToken.None).ConfigureAwait(false); } catch (Exception) { }
            try { if (_currentStream is not null) await _currentStream.DisposeAsync().ConfigureAwait(false); } catch (Exception) { }
#pragma warning restore CA1031
            _currentFileDate = today;
            _currentStream = OpenAppendStream(today);
        }

        try
        {
            await _currentStream!.WriteAsync(Encoding.UTF8.GetBytes(FormatLine(evt))).ConfigureAwait(false);
            await _currentStream.FlushAsync().ConfigureAwait(false);
        }
#pragma warning disable CA1031 // I/O failure must not crash the writer.
        catch (Exception ex)
        {
            if (Interlocked.Increment(ref _writeFailureCount) == 1)
                await Console.Error.WriteLineAsync($"PRism FileLogger write failed: {ex.Message}").ConfigureAwait(false);
        }
#pragma warning restore CA1031
    }

    private FileStream OpenAppendStream(DateOnly d)
    {
        Directory.CreateDirectory(_logsDir);  // self-heal against manual deletion
        var path = Path.Combine(_logsDir, $"prism-{d:yyyy-MM-dd}.log");
        return new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
    }

    private void RunRetentionSweep()
    {
        var today = DateOnly.FromDateTime(_now().LocalDateTime);
        foreach (var path in Directory.EnumerateFiles(_logsDir, "prism-*.log"))
        {
            var name = Path.GetFileName(path);
            var m = DailyLogFileName.Match(name);
            if (!m.Success) continue;

            if (!DateOnly.TryParseExact(m.Groups[1].Value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var fileDate))
                continue;

            // Boundary is strict >: a file dated exactly RetentionDays days ago is kept.
            if (today.DayNumber - fileDate.DayNumber <= RetentionDays) continue;

            try { File.Delete(path); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Interlocked.Increment(ref _retentionFailureCount);
            }
        }
    }

    private async Task EmitSessionStartLineAsync()
    {
        var version = typeof(FileLoggerProvider).Assembly.GetName().Version?.ToString() ?? "0.0.0";
        var line = FormatLine(new FileLogEvent(
            _now(),
            LogLevel.Information,
            "PRism.Web.Logging.FileLogger",
            new EventId(0, "SessionStarted"),
            $"session started, processId={Environment.ProcessId}, version={version}",
            null));

        // Must mirror WriteEventAsync's discipline: if this write throws, the exception
        // propagates out of RunWriterAsync's try-block to the fatal-stderr catch and the
        // writer task EXITS before reading a single channel event — turning the session's
        // logging into all _droppedDueToBackpressure increments. Wrap in same try/catch
        // pattern so the writer continues to drain even if the session-start marker is lost.
        // FlushAsync: spec's "eager flush per event for crash durability" — if the host
        // crashes between session-start and the first regular event, the session-start
        // marker should still be on disk.
        try
        {
            await _currentStream!.WriteAsync(Encoding.UTF8.GetBytes(line)).ConfigureAwait(false);
            await _currentStream.FlushAsync().ConfigureAwait(false);
        }
#pragma warning disable CA1031 // I/O failure must not crash the writer.
        catch (Exception ex)
        {
            if (Interlocked.Increment(ref _writeFailureCount) == 1)
                await Console.Error.WriteLineAsync($"PRism FileLogger session-start write failed: {ex.Message}").ConfigureAwait(false);
        }
#pragma warning restore CA1031
    }

    private async Task EmitSessionEndSummaryAsync()
    {
        if (_currentStream is null) return;

        try
        {
            var endLine = FormatLine(new FileLogEvent(
                _now(),
                LogLevel.Information,
                "PRism.Web.Logging.FileLogger",
                new EventId(1, "SessionEnding"),
                $"session ending, processId={Environment.ProcessId}",
                null));
            await _currentStream.WriteAsync(Encoding.UTF8.GetBytes(endLine)).ConfigureAwait(false);

            var dropped = Interlocked.Read(ref _droppedDueToBackpressure);
            if (dropped > 0)
            {
                var s = FormatLine(new FileLogEvent(
                    _now(), LogLevel.Warning, "PRism.Web.Logging.FileLogger",
                    new EventId(2, "DropsByBackpressure"),
                    $"{dropped} log events were dropped due to channel backpressure during this session.",
                    null));
                await _currentStream.WriteAsync(Encoding.UTF8.GetBytes(s)).ConfigureAwait(false);
            }

            var shutdownDropped = Interlocked.Read(ref _droppedDuringShutdown);
            if (shutdownDropped > 0)
            {
                var s = FormatLine(new FileLogEvent(
                    _now(), LogLevel.Information, "PRism.Web.Logging.FileLogger",
                    new EventId(3, "DropsByShutdown"),
                    $"{shutdownDropped} log events were elided during host shutdown drain.",
                    null));
                await _currentStream.WriteAsync(Encoding.UTF8.GetBytes(s)).ConfigureAwait(false);
            }
            await _currentStream.FlushAsync().ConfigureAwait(false);

            var writeFailures = Interlocked.Read(ref _writeFailureCount);
            if (writeFailures > 0)
                await Console.Error.WriteLineAsync($"PRism FileLogger had {writeFailures} write failures this session.").ConfigureAwait(false);

            var retentionFailures = Interlocked.Read(ref _retentionFailureCount);
            if (retentionFailures > 0)
                await Console.Error.WriteLineAsync($"PRism FileLogger could not delete {retentionFailures} stale log files this session.").ConfigureAwait(false);

            var parserFailures = Interlocked.Read(ref _parserFailureCount);
            if (parserFailures > 0)
                await Console.Error.WriteLineAsync($"PRism FileLogger had {parserFailures} template parser failures this session.").ConfigureAwait(false);
        }
#pragma warning disable CA1031 // Best-effort summary; never throw, but DO surface to operator.
        // Bare swallow was the worst failure mode: the only path that emits per-session
        // drop/write/parser counts going silent on host-shutdown FS fragility left the
        // operator with zero diagnostic. Route to stderr like the other failure paths.
        // Do NOT increment _writeFailureCount here — it has already been read for the
        // summary line above; just surface the partial-summary failure.
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"PRism FileLogger session-end summary failed: {ex.Message}").ConfigureAwait(false);
        }
#pragma warning restore CA1031
    }

    private static string FormatLine(FileLogEvent evt)
    {
        var ts = evt.Timestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        var levelStr = evt.Level switch
        {
            LogLevel.Trace => "Trace",
            LogLevel.Debug => "Debug",
            LogLevel.Information => "Information",
            LogLevel.Warning => "Warning",
            LogLevel.Error => "Error",
            LogLevel.Critical => "Critical",
            _ => evt.Level.ToString(),
        };

        var sb = new StringBuilder();
        sb.Append(ts).Append(" [").Append(levelStr).Append("] ").Append(evt.Category)
          .Append('[').Append(evt.EventId.Id).Append("]: ").Append(evt.FormattedMessage)
          .Append('\n');

        if (!string.IsNullOrEmpty(evt.ExceptionString))
        {
            foreach (var line in evt.ExceptionString.Split('\n'))
                sb.Append("    ").Append(line.TrimEnd('\r')).Append('\n');
        }

        return sb.ToString();
    }
}
