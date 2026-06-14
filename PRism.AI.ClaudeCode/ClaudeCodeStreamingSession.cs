using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

public sealed class ClaudeCodeStreamingSession : IStreamingLlmSession
{
    private readonly IStreamingCliProcess _process;
    private readonly ILogger<ClaudeCodeStreamingSession> _logger;   // drift-guard logging (Task 8)
    private readonly Channel<LlmEvent> _channel;
    private readonly CancellationTokenSource _readerCts = new();
    private readonly TaskCompletionSource _initTcs =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _readerTask;

    private volatile string _providerSessionId = "";
#pragma warning disable CS0414  // Assigned but value never used — read in 4b's SendUserTurnAsync (not yet implemented)
    private volatile bool _turnInFlight;
#pragma warning restore CS0414
#pragma warning disable CS0649  // Field is never assigned — assigned in 4b's SendUserTurnAsync
    private TaskCompletionSource? _turnTcs;          // guarded by lock(_turnGate)
#pragma warning restore CS0649
    private readonly object _turnGate = new();
#pragma warning disable CA1823, CS0169  // Fields used in later sub-tasks (4b/4e/Task 8) — not yet referenced in 4a skeleton
    private int _turnTextCount, _turnToolCount;      // per-turn output counters (drift guard, Task 8)
    private Task _lastWrite = Task.CompletedTask;     // last stdin write, drained by DisposeAsync (Task 4b/4e)
    private int _disposed;
#pragma warning restore CA1823, CS0169

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

    // Slice 4a: SUCCESS PATH ONLY. The is_error branch is added in 4c (red-first); the malformed/drift
    // branch in Task 8. The terminal LlmTurnComplete is written with CancellationToken.None — NEVER the
    // reader CT — so a forced EndCleanly/Dispose that cancels the reader cannot drop the turn's terminal
    // event out from under a consumer still draining it. (A truly stalled consumer is released instead by
    // EndCleanly/Dispose completing the writer, which surfaces as ChannelClosedException, caught above.)
    private async Task CompleteTurnAsync(ResultLine r, CancellationToken ct)
    {
        // TRIP BEFORE the (potentially blocking) channel write — else a stalled consumer hangs EndCleanly.
        lock (_turnGate) { _turnInFlight = false; _turnTcs?.TrySetResult(); }

        await _channel.Writer.WriteAsync(new LlmTurnComplete(
            r.FullText, r.InputTokens, r.OutputTokens, r.CacheReadInputTokens, r.EstimatedCostUsd),
            CancellationToken.None).ConfigureAwait(false);
    }

    // SendUserTurnAsync / EndCleanlyAsync / DisposeAsync added in 4b/4d/4e.
    public Task SendUserTurnAsync(string content, CancellationToken ct) => throw new NotImplementedException();
    public Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct) => throw new NotImplementedException();

    // Minimal DisposeAsync so 4a's `await using` works; replaced by the full version in 4e. Do NOT leave throwing.
    public async ValueTask DisposeAsync()
    {
        await _readerCts.CancelAsync().ConfigureAwait(false);
        _channel.Writer.TryComplete();
        _readerCts.Dispose();
        await _process.DisposeAsync().ConfigureAwait(false);
    }
}
