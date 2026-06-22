namespace PRism.AI.ClaudeCode;

/// <summary>
/// The env ALLOWLIST for spawning the `claude` CLI, shared by the provider and the availability
/// probe so both run in an identical environment. Only what the CLI needs to find itself + the
/// user profile that holds the /login credential, plus the node-version-manager vars an
/// npm-installed `claude` needs to exec its `node` shebang. Deliberately omits ANTHROPIC_*, proxy,
/// CLAUDE_CONFIG_DIR, and NODE_OPTIONS/NODE_EXTRA_CA_CERTS, so an inherited or captured value can
/// neither override the subscription, redirect egress/credentials, nor inject modules into node.
/// </summary>
internal static class ClaudeCliEnvironment
{
    /// <summary>Base vars: locate the CLI + the user profile that holds the /login credential.
    /// TMPDIR is the macOS/Unix temp var (Windows uses TEMP/TMP, which it sets instead).</summary>
    public static readonly string[] Allowlist =
        ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL", "TMPDIR"];

    /// <summary>Node-version-manager vars, PATH-POINTING ONLY (no credential/redirect). An
    /// npm-installed `claude` (shebang `#!/usr/bin/env node`) needs these so a shim manager
    /// (volta/asdf/fnm) can resolve `node`. Expansion is gated (spec §10). NEVER add a var that can
    /// carry a credential or redirect egress — every var here is persisted to disk and passed to the
    /// child. In particular NPM_CONFIG_PREFIX is included but per-registry auth tokens
    /// (NPM_CONFIG_//registry…/:_authToken) do NOT match it and are excluded.</summary>
    public static readonly string[] ManagerVarAllowlist =
        ["NVM_DIR", "VOLTA_HOME", "ASDF_DIR", "ASDF_DATA_DIR", "FNM_DIR", "N_PREFIX", "NPM_CONFIG_PREFIX", "PNPM_HOME"];

    /// <summary>POSIX env vars are case-sensitive; Windows is not. A case-collision must never admit
    /// an unlisted var (e.g. lowercase `nvm_dir`).</summary>
    private static readonly StringComparer KeyComparer =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    /// <summary>Build the child env from the CURRENT process environment (Windows / fallback path).
    /// Unchanged: still OrdinalIgnoreCase, still reads only the base allowlist from
    /// <see cref="Environment"/>. (Manager vars are irrelevant on the Windows native-PATH path.)</summary>
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

    /// <summary>Build the child env from a CAPTURED env block (the login-shell discovery path).
    /// Copies only keys in (base ∪ manager) allowlist, case-sensitively on POSIX. The result is
    /// allowlist-only by construction — an unlisted credential/redirect/node-option var in the
    /// captured block cannot pass through.</summary>
    public static Dictionary<string, string> FilterCaptured(IReadOnlyDictionary<string, string> captured)
    {
        ArgumentNullException.ThrowIfNull(captured);
        var allowed = new HashSet<string>(Allowlist, KeyComparer);
        allowed.UnionWith(ManagerVarAllowlist);

        var env = new Dictionary<string, string>(KeyComparer);
        foreach (var (k, v) in captured)
        {
            if (allowed.Contains(k)) env[k] = v;
        }
        return env;
    }
}
