namespace PRism.AI.ClaudeCode;

/// <summary>Recognizes the "the binary can't launch" stderr signatures that self-heal keys on:
/// a missing executable / a missing <c>node</c> for an npm-shebang <c>claude</c> (spec §6).</summary>
internal static class ClaudeExecSignatures
{
    // Match only the CANONICAL launcher-failure forms, not a loose "contains 'node' and 'No such
    // file'" — that would fire on unrelated `claude` log lines mentioning a missing node module and
    // cause spurious re-discovery on every probe cycle. These three cover an npm-shebang `claude`
    // whose `node` is gone (`env: node: …`) and the bare-node forms.
    private static readonly string[] Signatures =
        ["env: node:", "node: No such file or directory", "node: command not found"];

    internal static bool IsExecutableNotFound(string output)
    {
        if (string.IsNullOrEmpty(output)) return false;
        foreach (var sig in Signatures)
            if (output.Contains(sig, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
}
