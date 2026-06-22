using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>The Claude Code CLI provider's instance of the §2.3 capability descriptor.
/// DisabledStates mirror <see cref="ClaudeReasonCodes"/> (the credit states from spec §4 are
/// undocumented and folded into <see cref="ClaudeReasonCodes.Unknown"/> — not invented here).</summary>
public static class ClaudeProviderDescriptor
{
    public static ProviderCapabilityDescriptor Create() => new(
        DisabledStates: new[]
        {
            new ProviderDisabledState(ClaudeReasonCodes.CliNotInstalled, "Claude Code CLI is not installed."),
            new ProviderDisabledState(ClaudeReasonCodes.CliDiscoveryFailed, "Claude Code CLI was found but could not be launched."),
            new ProviderDisabledState(ClaudeReasonCodes.NotLoggedIn, "Not logged in to Claude Code."),
            new ProviderDisabledState(ClaudeReasonCodes.IdentityMismatch, "AI is disabled: the app is running as a different OS user than the Claude login."),
            new ProviderDisabledState(ClaudeReasonCodes.Unknown, "AI is unavailable for an unknown reason."),
        },
        SupportsStructuredOutput: true);
}
