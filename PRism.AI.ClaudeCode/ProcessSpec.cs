namespace PRism.AI.ClaudeCode;

/// <summary>
/// An external-process invocation. <paramref name="Environment"/> is an explicit ALLOWLIST —
/// the runner does NOT inherit the parent env (redirect/auth vars must not leak in).
/// <paramref name="StdinText"/> feeds the prompt via stdin (avoids arg-length limits).
/// </summary>
public sealed record ProcessSpec(
    string FileName,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> Environment,
    string WorkingDirectory,
    string? StdinText,
    TimeSpan Timeout);
