namespace PRism.AI.ClaudeCode;

/// <summary>Reason codes the Claude Code provider emits in <c>LlmAvailability.ReasonCode</c>.
/// Provider-owned vocabulary (the per-flag /api/capabilities mapping lands in a later PR).</summary>
public static class ClaudeReasonCodes
{
    public const string CliNotInstalled = "cli-not-installed";

    /// <summary>Discovery ran but could not produce a launchable binary (e.g. non-POSIX shell +
    /// ladder miss, or a manager-var gap). Distinguishes "installed but not discoverable" from a
    /// clean "not installed" — so logs (and any future UI) can tell them apart.</summary>
    public const string CliDiscoveryFailed = "cli-discovery-failed";
    public const string NotLoggedIn = "not-logged-in";
    public const string IdentityMismatch = "identity-mismatch";
    public const string Unknown = "unknown";
}
