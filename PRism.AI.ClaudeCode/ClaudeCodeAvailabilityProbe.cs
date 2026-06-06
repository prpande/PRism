using System.ComponentModel;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Availability + same-OS-user probe. First asserts the sidecar runs as the OS user whose
/// credential store the CLI reads (a mismatch could inherit a different user's login — block
/// WITHOUT probing). Then runs <c>claude --version</c> to confirm the CLI is installed. Known
/// failure signatures map to <see cref="ClaudeReasonCodes"/>; anything else is <c>Unknown</c>,
/// which the UI renders as the safe "AI unavailable — open Settings → AI" bucket. (Credit-state
/// signatures are deferred to a later milestone; until captured they fall into Unknown.)
/// </summary>
public sealed class ClaudeCodeAvailabilityProbe(
    ICliProcessRunner runner,
    ClaudeCodeProviderOptions options,
    Func<bool> identityMatches) : ILlmAvailabilityProbe
{
    public async Task<LlmAvailability> ProbeAsync(CancellationToken ct)
    {
        if (!identityMatches())
            return LlmAvailability.Unavailable(ClaudeReasonCodes.IdentityMismatch);

        var spec = new ProcessSpec(
            FileName: options.ClaudeExecutable,
            Arguments: ["--version"],
            Environment: ClaudeCliEnvironment.BuildAllowlisted(),
            WorkingDirectory: options.WorkingDirectory,
            StdinText: null,
            Timeout: options.ProbeTimeout);

        ProcessResult result;
        try
        {
            result = await runner.RunAsync(spec, ct).ConfigureAwait(false);
        }
        catch (Win32Exception)
        {
            // Process.Start throws this when the executable is absent / not on PATH.
            return LlmAvailability.Unavailable(ClaudeReasonCodes.CliNotInstalled);
        }

        if (result.ExitCode == 0 && !result.TimedOut)
            return LlmAvailability.Ok;

        // Map known failure signatures; everything else is the safe Unknown bucket.
        // Some CLI versions may write these signatures to stdout instead of stderr — check both.
        var output = result.Stderr + "\n" + result.Stdout;
        if (output.Contains("Not logged in", StringComparison.OrdinalIgnoreCase))
            return LlmAvailability.Unavailable(ClaudeReasonCodes.NotLoggedIn);
        if (output.Contains("cannot find the file", StringComparison.OrdinalIgnoreCase))
            return LlmAvailability.Unavailable(ClaudeReasonCodes.CliNotInstalled);
        return LlmAvailability.Unavailable(ClaudeReasonCodes.Unknown);
    }
}
