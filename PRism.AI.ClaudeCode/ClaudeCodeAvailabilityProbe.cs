using System.ComponentModel;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Liveness probe. Resolution (find + identity) now lives in <see cref="IClaudeCliLocator"/>; this
/// probe maps a <see cref="NotFound"/> onto the reason-code vocabulary, and on a <see cref="ResolvedCli"/>
/// runs <c>claude --version</c> under the resolved invocation to confirm login/credit-independent
/// liveness. A spawn that hits an executable-not-found signature self-heals via
/// <see cref="IClaudeCliLocator.InvalidateResolved"/> so the next resolve re-discovers (spec §6/§7).
/// </summary>
public sealed class ClaudeCodeAvailabilityProbe(
    ICliProcessRunner runner,
    ClaudeCodeProviderOptions options,
    IClaudeCliLocator locator) : ILlmAvailabilityProbe
{
    public async Task<LlmAvailability> ProbeAsync(CancellationToken ct)
    {
        var resolution = await locator.ResolveAsync(ct).ConfigureAwait(false);
        if (resolution is NotFound notFound)
            return LlmAvailability.Unavailable(notFound.ReasonCode);

        var resolved = (ResolvedCli)resolution;
        var spec = new ProcessSpec(
            FileName: resolved.ExecutablePath,
            Arguments: ["--version"],
            Environment: resolved.Environment,
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
            // Binary vanished between resolve and spawn → self-heal + report not-installed.
            locator.InvalidateResolved();
            return LlmAvailability.Unavailable(ClaudeReasonCodes.CliNotInstalled);
        }

        var output = result.Stderr + "\n" + result.Stdout;
        if (ClaudeExecSignatures.IsExecutableNotFound(output))
        {
            // npm shim present but its `node` is gone (version-manager swap) → self-heal.
            locator.InvalidateResolved();
            return LlmAvailability.Unavailable(ClaudeReasonCodes.CliNotInstalled);
        }

        if (result.ExitCode == 0 && !result.TimedOut)
            return LlmAvailability.Ok;

        if (output.Contains("Not logged in", StringComparison.OrdinalIgnoreCase))
            return LlmAvailability.Unavailable(ClaudeReasonCodes.NotLoggedIn);
        return LlmAvailability.Unavailable(ClaudeReasonCodes.Unknown);
    }
}
