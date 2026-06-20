using System.Threading.Channels;

namespace PRism.AI.ClaudeCode.Tests;

/// <summary>Scripted streaming process for unit tests. The test pushes stdout lines via
/// <see cref="EmitLine"/> / <see cref="EmitLines"/> and ends the stream via <see cref="EndStdout"/>
/// (clean EOF) or <see cref="KillStdout"/> (faults the stream to simulate process death). Records
/// every stdin write in <see cref="StdinWrites"/>. Never spawns a process.</summary>
public sealed class FakeStreamingCliProcess : IStreamingCliProcess
{
    private readonly Channel<string> _stdout = Channel.CreateUnbounded<string>();
    public List<string> StdinWrites { get; } = new();
    public bool StdinClosed { get; private set; }
    public bool Disposed { get; private set; }
    public int ExitCodeToReturn { get; set; }
    public StreamingProcessSpec? Spec { get; }

    /// <summary>Set to simulate a broken-pipe failure on the next (and subsequent) stdin write — the write
    /// task faults with this exception, modelling the child dying mid-write (used by the dispose-race test).</summary>
    public Exception? WriteException { get; set; }

    public FakeStreamingCliProcess(StreamingProcessSpec? spec = null) => Spec = spec;

    public void EmitLine(string line) => _stdout.Writer.TryWrite(line);
    public void EmitLines(params string[] lines) { foreach (var l in lines) _stdout.Writer.TryWrite(l); }
    public void EndStdout() => _stdout.Writer.TryComplete();
    public void KillStdout() => _stdout.Writer.TryComplete(new IOException("process died"));

    public IAsyncEnumerable<string> StdoutLines => _stdout.Reader.ReadAllAsync();

    public Task WriteLineAsync(string line, CancellationToken ct)
    {
        StdinWrites.Add(line);
        return WriteException is not null ? Task.FromException(WriteException) : Task.CompletedTask;
    }
    // Models the real CLI: closing stdin ends the session, so the child exits and stdout reaches EOF.
    public Task CloseStdinAsync() { StdinClosed = true; _stdout.Writer.TryComplete(); return Task.CompletedTask; }
    public Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct) => Task.FromResult(ExitCodeToReturn);
    public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; }
}

/// <summary>Factory returning a pre-built <see cref="FakeStreamingCliProcess"/> and capturing the spec.</summary>
public sealed class FakeStreamingCliProcessFactory : IStreamingCliProcessFactory
{
    private readonly FakeStreamingCliProcess _process;
    public StreamingProcessSpec? CapturedSpec { get; private set; }
    public FakeStreamingCliProcessFactory(FakeStreamingCliProcess process) => _process = process;
    public IStreamingCliProcess Start(StreamingProcessSpec spec) { CapturedSpec = spec; return _process; }
}
