namespace PRism.AI.ClaudeCode;

/// <summary>Reason codes the Claude Code provider emits in <c>LlmAvailability.ReasonCode</c>.
/// Provider-owned vocabulary (the per-flag /api/capabilities mapping lands in a later PR).</summary>
public static class ClaudeReasonCodes
{
    public const string CliNotInstalled = "cli-not-installed";
    public const string NotLoggedIn = "not-logged-in";
    public const string IdentityMismatch = "identity-mismatch";
    public const string Unknown = "unknown";
}
