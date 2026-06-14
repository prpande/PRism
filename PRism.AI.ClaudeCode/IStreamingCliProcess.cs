namespace PRism.AI.ClaudeCode;

/// <summary>Spawns the persistent streaming process. Exists SOLELY for test-double injection —
/// <c>SystemStreamingCliProcessFactory</c> is the only planned real implementor; do not treat
/// this as an extension point for additional providers.</summary>
public interface IStreamingCliProcessFactory
{
    IStreamingCliProcess Start(StreamingProcessSpec spec);
}

/// <summary>One persistent child process with redirected stdin/stdout. Mirrors
/// <see cref="SystemCliProcessRunner"/>'s isolation (env allowlist, KillTree) but for a long-lived
/// session rather than run-to-completion.</summary>
public interface IStreamingCliProcess : IAsyncDisposable
{
    /// <summary>Line-delimited stdout. The real impl loops <c>StandardOutput.ReadLineAsync</c>
    /// (NOT <c>BeginOutputReadLine</c>, which buffers and cannot stream per-line).</summary>
    IAsyncEnumerable<string> StdoutLines { get; }

    /// <summary>Append one NDJSON line (+newline) to the child's stdin.</summary>
    Task WriteLineAsync(string line, CancellationToken ct);

    /// <summary>Close the child's stdin — signals a clean end so the child exits 0 at the next boundary.</summary>
    Task CloseStdinAsync();

    /// <summary>Await exit up to <paramref name="timeout"/>; on timeout kill the process tree and
    /// return -1. Returns the exit code otherwise.</summary>
    Task<int> WaitForExitAsync(TimeSpan timeout, CancellationToken ct);
}

/// <summary>Mirrors <see cref="ProcessSpec"/> minus the one-shot <c>StdinText</c>/<c>Timeout</c>
/// (stdin is live; there is no single per-call timeout). <see cref="Environment"/> is an explicit
/// ALLOWLIST — the real impl does NOT inherit the parent env.</summary>
public sealed record StreamingProcessSpec(
    string FileName,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> Environment,
    string WorkingDirectory);
