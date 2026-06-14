using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

public sealed partial class ClaudeCodeStreamingSession : IStreamingLlmSession
{
    private readonly IStreamingCliProcess _process;
    private readonly ILogger<ClaudeCodeStreamingSession> _logger;   // drift-guard logging (Task 8)
    private readonly Channel<LlmEvent> _channel;
    private readonly CancellationTokenSource _readerCts = new();
    private readonly TaskCompletionSource _initTcs =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _readerTask;

    private volatile string _providerSessionId = "";
    private volatile bool _turnInFlight;
    private TaskCompletionSource? _turnTcs;          // guarded by lock(_turnGate)
    private readonly object _turnGate = new();
    private int _turnTextCount, _turnToolCount;      // per-turn output counters (drift guard, Task 8)
    private volatile Task _lastWrite = Task.CompletedTask;     // last stdin write, drained by DisposeAsync (4e)
    private int _disposed;

    public ClaudeCodeStreamingSession(IStreamingCliProcess process)
        : this(process, NullLogger<ClaudeCodeStreamingSession>.Instance) { }

    // channelCapacity is a TEST SEAM (default 1024). Tests set a small cap to deterministically
    // SATURATE the channel and exercise back-pressure / trip-before-write (Tasks 4d/4f) — the bug those
    // invariants guard only manifests when the channel is actually full.
    public ClaudeCodeStreamingSession(
        IStreamingCliProcess process,
        ILogger<ClaudeCodeStreamingSession> logger,
        int channelCapacity = 1024)
    {
        _process = process;
        _logger = logger;
        _channel = Channel.CreateBounded<LlmEvent>(new BoundedChannelOptions(channelCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = true,
        });
        _readerTask = Task.Run(() => ReadLoopAsync(_readerCts.Token));
    }

    public string ProviderSessionId => _providerSessionId;
    public IAsyncEnumerable<LlmEvent> Events => _channel.Reader.ReadAllAsync();

    private async Task ReadLoopAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var line in _process.StdoutLines.WithCancellation(ct).ConfigureAwait(false))
            {
                var parsed = ClaudeStreamJson.Parse(line);
                switch (parsed.Kind)
                {
                    case StreamLineKind.Init:
                        _providerSessionId = parsed.SessionId ?? "";
                        _initTcs.TrySetResult();
                        break;
                    case StreamLineKind.TextDelta:
                        _turnTextCount++;
                        await _channel.Writer.WriteAsync(new LlmTextDelta(parsed.Text!), ct).ConfigureAwait(false);
                        break;
                    case StreamLineKind.ToolUse:
                        _turnToolCount++;
                        await _channel.Writer.WriteAsync(
                            new LlmToolUse(parsed.ToolName ?? "", parsed.ToolInput ?? default), ct).ConfigureAwait(false);
                        break;
                    case StreamLineKind.Result:
                        await CompleteTurnAsync(parsed.Result!, ct).ConfigureAwait(false);
                        break;
                }
            }
            // Clean stdout EOF.
            _initTcs.TrySetResult();            // unblock a zero-turn EndCleanly if init never arrived
            _channel.Writer.TryComplete();
        }
        catch (OperationCanceledException) { _channel.Writer.TryComplete(); }
        catch (ChannelClosedException) { /* writer completed during shutdown — expected */ }
#pragma warning disable CA1031  // Intentional catch-all: process-death/pipe-break is unrecoverable; we must not re-throw from the reader task
        catch (Exception ex)                    // process death / pipe break -> unrecoverable
        {
            _initTcs.TrySetResult();
            _channel.Writer.TryComplete(new LlmProviderException(
                "claude streaming process died.", stderr: string.Empty, exitCode: -1, innerException: ex));
        }
#pragma warning restore CA1031
    }

    // The terminal LlmTurnComplete is written with CancellationToken.None — NEVER the reader CT — so a
    // forced EndCleanly/Dispose that cancels the reader cannot drop the turn's terminal event out from
    // under a consumer still draining it. (A truly stalled consumer is released instead by
    // EndCleanly/Dispose completing the writer, which surfaces as ChannelClosedException, caught above.)
    private async Task CompleteTurnAsync(ResultLine r, CancellationToken ct)
    {
        if (r.Malformed)   // unmappable result -> unrecoverable (spec §4 turn-termination liveness)
        {
            Log.MalformedResult(_logger);
            lock (_turnGate) { _turnInFlight = false; _turnTcs?.TrySetResult(); }   // resolve the turn
            _channel.Writer.TryComplete(new LlmProviderException(
                "claude streaming returned an unmappable result line.", stderr: string.Empty, exitCode: 0));
            return;
        }
        if (!r.IsError && _turnTextCount == 0 && _turnToolCount == 0)
            Log.ZeroOutputTurn(_logger);

        // TRIP BEFORE the (potentially blocking) channel write — else a stalled consumer hangs EndCleanly.
        lock (_turnGate) { _turnInFlight = false; _turnTcs?.TrySetResult(); }

        if (r.IsError)
        {
            await _channel.Writer.WriteAsync(
                new LlmTurnError(string.IsNullOrEmpty(r.FullText) ? (r.Code ?? "error") : r.FullText, r.Code),
                CancellationToken.None).ConfigureAwait(false);
        }
        await _channel.Writer.WriteAsync(new LlmTurnComplete(
            r.FullText, r.InputTokens, r.OutputTokens, r.CacheReadInputTokens, r.EstimatedCostUsd),
            CancellationToken.None).ConfigureAwait(false);
    }

    private static readonly System.Text.Json.JsonSerializerOptions JsonOpts = new();

    public Task SendUserTurnAsync(string content, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);
        lock (_turnGate)
        {
            if (_turnInFlight)
                throw new InvalidOperationException("A turn is already in flight; await its LlmTurnComplete first.");
            _turnInFlight = true;
            _turnTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _turnTextCount = 0; _turnToolCount = 0;     // reset per-turn output counters (drift guard)
        }
        var line = System.Text.Json.JsonSerializer.Serialize(new
        {
            type = "user",
            message = new { role = "user", content = new[] { new { type = "text", text = content } } },
        }, JsonOpts);
        // Retain the write task so DisposeAsync can drain a broken-pipe IOException (spec §7 dispose-race).
        // Sequential-turn enforcement above guarantees no overlapping writer, so a plain field assign is safe.
        _lastWrite = _process.WriteLineAsync(line, ct);
        return _lastWrite;
    }

    public async Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct)
    {
        // 1) Wait for the in-flight turn's completion (or init, if no turn) up to gracefulTimeout.
        Task waitOn;
        lock (_turnGate) waitOn = _turnInFlight && _turnTcs is not null ? _turnTcs.Task : _initTcs.Task;

        if (!await WaitBounded(waitOn, gracefulTimeout, ct).ConfigureAwait(false))
        {
            await ForceTerminateAsync().ConfigureAwait(false);     // timeout/cancel -> forced end, no throw
            return new SessionEndState(LastTurnEndedCleanly: false, ProviderSessionId: _providerSessionId);
        }

        // 2) Clean boundary: close stdin (child exits at the boundary), await exit.
        await _process.CloseStdinAsync().ConfigureAwait(false);
        var exit = await _process.WaitForExitAsync(gracefulTimeout, CancellationToken.None).ConfigureAwait(false);

        // 3) Let the reader drain to stdout-EOF and complete the channel ITSELF, so a consumer still
        //    draining receives the terminal LlmTurnComplete. Do NOT cancel the reader on the clean path —
        //    cancelling here would race the reader's terminal write (issued on CancellationToken.None) and,
        //    for a stalled consumer, drop it. Bound the wait; only force if the reader is wedged on a
        //    non-draining consumer (which has abandoned the stream anyway).
        if (!await WaitBounded(_readerTask, gracefulTimeout, CancellationToken.None).ConfigureAwait(false))
        {
            await _readerCts.CancelAsync().ConfigureAwait(false);
            _channel.Writer.TryComplete();
        }
        return new SessionEndState(LastTurnEndedCleanly: exit == 0, ProviderSessionId: _providerSessionId);
    }

    private static async Task<bool> WaitBounded(Task task, TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(timeout);
            var delay = Task.Delay(Timeout.Infinite, timeoutCts.Token);
            var winner = await Task.WhenAny(task, delay).ConfigureAwait(false);
            return winner == task;
        }
        catch (OperationCanceledException) { return false; }
    }

    private async Task ForceTerminateAsync()
    {
        await _readerCts.CancelAsync().ConfigureAwait(false);
        _channel.Writer.TryComplete();
        await _process.WaitForExitAsync(TimeSpan.FromSeconds(2), CancellationToken.None).ConfigureAwait(false);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning,
            Message = "claude stream-json: unrecognized result envelope shape — possible CLI drift (spec §9.1).")]
        internal static partial void MalformedResult(ILogger logger);

        [LoggerMessage(Level = LogLevel.Warning,
            Message = "claude stream-json: turn completed with zero text and zero tool output — possible CLI drift (spec §9.1).")]
        internal static partial void ZeroOutputTurn(ILogger logger);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        await _readerCts.CancelAsync().ConfigureAwait(false);
        _channel.Writer.TryComplete();
        // Drain an in-flight stdin write so a broken-pipe IOException (child killed below mid-write) does
        // NOT escape dispose. Swallow only IOException/OperationCanceledException — a real fault elsewhere
        // should still surface. (spec §7 dispose-race.)
        try { await _lastWrite.ConfigureAwait(false); }
        catch (IOException) { /* broken pipe — child exited/killed before stdin drained */ }
        catch (OperationCanceledException) { /* write cancelled by the caller's ct */ }
#pragma warning disable CA1031  // Best-effort reader teardown during dispose — any exception here is a secondary failure
        try { await _readerTask.ConfigureAwait(false); } catch { /* reader teardown best-effort */ }
#pragma warning restore CA1031
        await _process.DisposeAsync().ConfigureAwait(false);   // SystemStreamingCliProcess KillTrees here
        _readerCts.Dispose();
    }
}
