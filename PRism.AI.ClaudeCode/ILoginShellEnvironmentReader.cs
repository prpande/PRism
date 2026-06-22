namespace PRism.AI.ClaudeCode;

/// <summary>Reproduces the user's login-shell environment so both `claude` and the `node` an
/// npm-install needs resolve the way they do in the user's terminal. The ONE seam that touches the
/// login shell; faked in unit tests, exercised for real only in manual P1.</summary>
public interface ILoginShellEnvironmentReader
{
    /// <summary>Spawn <c>$SHELL -ilc</c> with a CLEARED env and capture the reconstructed env +
    /// <c>command -v claude</c>. Returns <c>null</c> on timeout, a non-POSIX shell, or a garbled
    /// capture (caller falls to the degradation ladder).</summary>
    Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct);
}
