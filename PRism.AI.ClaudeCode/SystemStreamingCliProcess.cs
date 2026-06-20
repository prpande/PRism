using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace PRism.AI.ClaudeCode;

public sealed class SystemStreamingCliProcessFactory : IStreamingCliProcessFactory
{
    public IStreamingCliProcess Start(StreamingProcessSpec spec) => SystemStreamingCliProcess.Start(spec);
}

/// <summary>The only persistent-session class touching <c>System.Diagnostics</c>. Env is the explicit
/// allowlist (parent block cleared). stdout is streamed line-by-line via <c>ReadLineAsync</c>; stderr is
/// drained continuously so the child cannot block on a full stderr pipe.
/// Validated manually against the real `claude` binary (spec §7 P1), not in CI.</summary>
public sealed class SystemStreamingCliProcess : IStreamingCliProcess
{
    private readonly Process _process;
    private readonly Task _stderrDrain;
    private int _disposed;

    private SystemStreamingCliProcess(Process process)
    {
        _process = process;
        // Drain stderr continuously. RedirectStandardError is on, so an UNREAD stderr pipe fills (~64 KB)
        // and the child BLOCKS on its next stderr write — deadlocking the whole session (the stdout reader
        // then waits forever for a line the wedged child never emits). SystemCliProcessRunner avoids the
        // same hazard with BeginErrorReadLine; the long-lived streaming session makes it reachable on any
        // error-chatty turn. Content is discarded (the streaming path carries no stderr into
        // LlmProviderException); teardown faults (pipe closed on exit/kill) are swallowed.
        _stderrDrain = Task.Run(async () =>
        {
#pragma warning disable CA1031  // Intentional catch-all: stderr pipe closes on exit/kill with IOException or ObjectDisposedException; we must not re-throw from the drain task
            try { while (await _process.StandardError.ReadLineAsync().ConfigureAwait(false) is not null) { } }
            catch { /* stderr pipe closed on exit/kill — expected */ }
#pragma warning restore CA1031
        });
    }

    public static SystemStreamingCliProcess Start(StreamingProcessSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        var psi = new ProcessStartInfo
        {
            FileName = spec.FileName,
            WorkingDirectory = spec.WorkingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in spec.Arguments) psi.ArgumentList.Add(a);
        psi.Environment.Clear();
        foreach (var (k, v) in spec.Environment) psi.Environment[k] = v;

        var process = new Process { StartInfo = psi };
        process.Start();
        return new SystemStreamingCliProcess(process);   // ctor starts the stderr drain
    }

    // PROPERTY (satisfies `IStreamingCliProcess.StdoutLines { get; }`). It returns a private iterator whose
    // [EnumeratorCancellation] parameter receives the token from the reader's `.WithCancellation(ct)` call —
    // a property getter cannot declare a CT parameter itself, so the cancellation flows through the iterator.
    public IAsyncEnumerable<string> StdoutLines => ReadLinesAsync();

    private async IAsyncEnumerable<string> ReadLinesAsync([EnumeratorCancellation] CancellationToken ct = default)
    {
        var reader = _process.StandardOutput;
        while (await reader.ReadLineAsync(ct).ConfigureAwait(false) is { } line)
            yield return line;
    }

    public Task WriteLineAsync(string line, CancellationToken ct) =>
        _process.StandardInput.WriteLineAsync(line.AsMemory(), ct);

    public Task CloseStdinAsync() { _process.StandardInput.Close(); return Task.CompletedTask; }

    public async Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        try { await _process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false); return _process.ExitCode; }
        catch (OperationCanceledException)
        {
            try { _process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return -1;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { if (!_process.HasExited) _process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
#pragma warning disable CA1031  // Best-effort stderr drain teardown during dispose — any exception here is a secondary failure
        try { await _stderrDrain.ConfigureAwait(false); } catch { /* drain teardown best-effort */ }
#pragma warning restore CA1031
        _process.Dispose();
    }
}
