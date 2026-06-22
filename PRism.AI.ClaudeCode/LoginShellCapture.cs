namespace PRism.AI.ClaudeCode;

/// <summary>The result of reproducing the user's login-shell environment: the full captured env
/// block, and the <c>command -v claude</c> result (null when the shell could not resolve it).</summary>
public sealed record LoginShellCapture(
    IReadOnlyDictionary<string, string> Environment,
    string? CommandVClaude);
