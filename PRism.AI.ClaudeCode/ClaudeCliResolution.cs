namespace PRism.AI.ClaudeCode;

/// <summary>Result of resolving the <c>claude</c> CLI: either a launchable invocation
/// (<see cref="ResolvedCli"/>) or a failure with a reason code (<see cref="NotFound"/>).</summary>
public abstract record ClaudeCliResolution;

/// <summary>A launchable invocation: the executable path and the exact ALLOWLISTED child env to
/// spawn it under. Both topologies (native binary, npm+node shebang) collapse to this shape.</summary>
public sealed record ResolvedCli(
    string ExecutablePath,
    IReadOnlyDictionary<string, string> Environment) : ClaudeCliResolution;

/// <summary>No launchable <c>claude</c> was found. <paramref name="ReasonCode"/> is a
/// <see cref="ClaudeReasonCodes"/> value the availability probe maps to its vocabulary.</summary>
public sealed record NotFound(string ReasonCode) : ClaudeCliResolution;
