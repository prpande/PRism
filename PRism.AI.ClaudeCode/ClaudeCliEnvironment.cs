namespace PRism.AI.ClaudeCode;

/// <summary>
/// The env ALLOWLIST for spawning the `claude` CLI, shared by the provider and the availability
/// probe so both run in an identical environment. Only what the CLI needs to find itself + the
/// user profile that holds the /login credential. Deliberately omits ANTHROPIC_* and proxy vars
/// and CLAUDE_CONFIG_DIR, so an inherited value can neither override the subscription nor redirect
/// egress/credentials. (The Node CLI may additionally need APPDATA/LOCALAPPDATA — to be verified
/// empirically against the real binary; add them here then if `claude --version` fails in-child.)
/// </summary>
internal static class ClaudeCliEnvironment
{
    public static readonly string[] Allowlist =
        ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"];

    public static Dictionary<string, string> BuildAllowlisted()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in Allowlist)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (value is not null) env[key] = value;
        }
        return env;
    }
}
