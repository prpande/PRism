using System.ComponentModel;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeAvailabilityProbeTests
{
    private static ClaudeCodeAvailabilityProbe Build(ProcessResult versionResult, bool identityMatches = true)
    {
        var runner = new FakeCliProcessRunner(versionResult);
        return new ClaudeCodeAvailabilityProbe(
            runner,
            new ClaudeCodeProviderOptions { ClaudeExecutable = "claude", WorkingDirectory = @"C:\tmp" },
            identityMatches: () => identityMatches);
    }

    [Fact]
    public async Task Reports_available_when_version_succeeds_and_identity_matches()
    {
        var probe = Build(new ProcessResult(0, "2.1.150", "", false));
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.Should().Be(LlmAvailability.Ok);
    }

    [Fact]
    public async Task Reports_cli_not_installed_when_version_exits_with_not_found_stderr()
    {
        var probe = Build(new ProcessResult(-1, "", "The system cannot find the file specified", false));
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.Available.Should().BeFalse();
        result.ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
    }

    [Fact]
    public async Task Reports_cli_not_installed_when_runner_throws_win32()
    {
        var runner = new FakeCliProcessRunner(new Win32Exception("The system cannot find the file specified"));
        var probe = new ClaudeCodeAvailabilityProbe(
            runner,
            new ClaudeCodeProviderOptions { ClaudeExecutable = "claude", WorkingDirectory = @"C:\tmp" },
            identityMatches: () => true);
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
    }

    [Fact]
    public async Task Reports_not_logged_in_when_stderr_says_so()
    {
        var probe = Build(new ProcessResult(1, "", "Not logged in · Please run /login", false));
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.ReasonCode.Should().Be(ClaudeReasonCodes.NotLoggedIn);
    }

    [Fact]
    public async Task Reports_not_logged_in_when_signature_is_on_stdout()
    {
        var probe = Build(new ProcessResult(1, "Not logged in · Please run /login", "", false));
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.ReasonCode.Should().Be(ClaudeReasonCodes.NotLoggedIn);
    }

    [Fact]
    public async Task Reports_identity_mismatch_and_does_not_probe_version()
    {
        var probe = Build(new ProcessResult(0, "2.1.150", "", false), identityMatches: false);
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.ReasonCode.Should().Be(ClaudeReasonCodes.IdentityMismatch);
    }

    [Fact]
    public async Task Maps_unrecognized_failure_to_unknown()
    {
        var probe = Build(new ProcessResult(1, "", "some unexpected error", false));
        var result = await probe.ProbeAsync(CancellationToken.None);
        result.ReasonCode.Should().Be(ClaudeReasonCodes.Unknown);
    }
}
