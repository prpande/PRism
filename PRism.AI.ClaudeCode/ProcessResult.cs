namespace PRism.AI.ClaudeCode;

/// <summary>Result of an external-process run: exit code, captured streams, and whether it timed out.</summary>
public sealed record ProcessResult(int ExitCode, string Stdout, string Stderr, bool TimedOut);
