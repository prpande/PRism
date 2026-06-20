using System.Text.RegularExpressions;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// A <c>claude</c> CLI call failed. <see cref="Stderr"/> is REDACTED + truncated for in-app
/// diagnostics ONLY — it may carry token/keychain fragments, so do not forward it raw to a log
/// sink that persists or indexes it.
/// </summary>
public sealed partial class LlmProviderException : Exception
{
    private const int MaxStderr = 512;

    /// <summary>Redacted, length-capped stderr (in-app diagnostics only).</summary>
    public string Stderr { get; }

    /// <summary>Process exit code (-1 for timeout / spawn failure).</summary>
    public int ExitCode { get; }

    /// <summary>True ONLY when the CLI call exceeded its wall-clock timeout (#496). False on
    /// exit-code, spawn (Win32Exception), and JSON-parse failures. Used by AiEndpoints to pick the
    /// 503 reason. ExitCode is -1 for BOTH timeout and spawn-not-found, so it is not a reliable
    /// discriminator — this flag is.</summary>
    public bool TimedOut { get; }

    public LlmProviderException(string message, string stderr, int exitCode, Exception? innerException = null, bool timedOut = false)
        : base(message, innerException)
    {
        Stderr = Redact(stderr);
        ExitCode = exitCode;
        TimedOut = timedOut;
    }

    // Standard exception constructors (CA1032). The CLI-failure path always uses the 3-arg
    // ctor above; these exist for framework conformance and default Stderr/ExitCode to safe values.
    public LlmProviderException()
    {
        Stderr = string.Empty;
    }

    public LlmProviderException(string message) : base(message)
    {
        Stderr = string.Empty;
    }

    public LlmProviderException(string message, Exception innerException) : base(message, innerException)
    {
        Stderr = string.Empty;
    }

    private static string Redact(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        var s = AnthropicKeyRegex().Replace(raw, "[redacted]");
        s = BearerRegex().Replace(s, "Bearer [redacted]");
        s = TokenRegex().Replace(s, "token=[redacted]");
        s = HexRegex().Replace(s, "[redacted]");
        return s.Length > MaxStderr ? s[..MaxStderr] : s;
    }

    [GeneratedRegex(@"sk-ant-\S+", RegexOptions.IgnoreCase)]
    private static partial Regex AnthropicKeyRegex();

    [GeneratedRegex(@"Bearer\s+\S+", RegexOptions.IgnoreCase)]
    private static partial Regex BearerRegex();

    [GeneratedRegex(@"token=\S+", RegexOptions.IgnoreCase)]
    private static partial Regex TokenRegex();

    [GeneratedRegex("[0-9a-fA-F]{32,}")]
    private static partial Regex HexRegex();
}
