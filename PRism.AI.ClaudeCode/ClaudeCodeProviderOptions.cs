namespace PRism.AI.ClaudeCode;

/// <summary>Configuration for <see cref="ClaudeCodeLlmProvider"/>.</summary>
public sealed class ClaudeCodeProviderOptions
{
    /// <summary>The <c>claude</c> executable name or absolute path. A bare name ("claude") is
    /// resolved against PATH at spawn time — PATH is treated as trusted here. To eliminate
    /// PATH-shadowing, set an absolute path resolved once at registration.</summary>
    public string ClaudeExecutable { get; init; } = "claude";

    /// <summary>A STABLE, NON-GIT working directory. <c>--exclude-dynamic-system-prompt-sections</c>
    /// MOVES per-machine prompt sections into the first user message (it does not delete them);
    /// the cross-process cache prefix is only byte-stable if cwd is stable AND non-git (a git tree
    /// re-injects git status even with the flag). The cache benefit is MEASURED in P1b. PRism
    /// creates this under its per-user dataDir.</summary>
    public required string WorkingDirectory { get; init; }

    /// <summary>Hard wall-clock ceiling per call.</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>Wall-clock ceiling for the `claude --version` availability probe (separate from
    /// <see cref="Timeout"/>, which bounds full completions).</summary>
    public TimeSpan ProbeTimeout { get; init; } = TimeSpan.FromSeconds(10);
}
