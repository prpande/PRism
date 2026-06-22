using System.ComponentModel;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeAvailabilityProbeTests
{
    private static readonly IReadOnlyDictionary<string, string> Env =
        new Dictionary<string, string> { ["PATH"] = "/usr/bin" };

    private static ClaudeCodeAvailabilityProbe Build(
        ProcessResult versionResult, ClaudeCliResolution? resolution = null, FakeCliProcessRunner? runner = null)
    {
        resolution ??= new ResolvedCli("/usr/bin/claude", Env);
        return new ClaudeCodeAvailabilityProbe(
            runner ?? new FakeCliProcessRunner(versionResult),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp" },
            new FakeClaudeCliLocator(resolution));
    }

    [Fact]
    public async Task Reports_available_when_version_succeeds()
    {
        var probe = Build(new ProcessResult(0, "2.1.150", "", false));
        (await probe.ProbeAsync(CancellationToken.None)).Should().Be(LlmAvailability.Ok);
    }

    [Fact]
    public async Task Maps_locator_NotFound_cli_not_installed()
    {
        var probe = Build(new ProcessResult(0, "", "", false),
            resolution: new NotFound(ClaudeReasonCodes.CliNotInstalled));
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
    }

    [Fact]
    public async Task Maps_locator_NotFound_discovery_failed()
    {
        var probe = Build(new ProcessResult(0, "", "", false),
            resolution: new NotFound(ClaudeReasonCodes.CliDiscoveryFailed));
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    [Fact]
    public async Task Maps_locator_NotFound_identity_mismatch_without_probing()
    {
        var runner = new FakeCliProcessRunner(new ProcessResult(0, "2.1.150", "", false));
        var probe = Build(new ProcessResult(0, "2.1.150", "", false),
            resolution: new NotFound(ClaudeReasonCodes.IdentityMismatch), runner: runner);
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.IdentityMismatch);
        runner.Captured.Should().BeNull();   // no --version spawn on a NotFound
    }

    [Fact]
    public async Task Reports_not_logged_in_from_version_output()
    {
        var probe = Build(new ProcessResult(1, "", "Not logged in · Please run /login", false));
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.NotLoggedIn);
    }

    [Fact]
    public async Task Invalidates_locator_when_version_throws_win32()
    {
        var locator = new FakeClaudeCliLocator(new ResolvedCli("/usr/bin/claude", Env));
        var probe = new ClaudeCodeAvailabilityProbe(
            new FakeCliProcessRunner(new Win32Exception("The system cannot find the file specified")),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp" }, locator);

        var result = await probe.ProbeAsync(CancellationToken.None);

        result.ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
        locator.InvalidateCount.Should().Be(1);   // self-heal: re-discover next time
    }

    [Fact]
    public async Task Invalidates_locator_on_node_not_found_signature()
    {
        var locator = new FakeClaudeCliLocator(new ResolvedCli("/usr/bin/claude", Env));
        var probe = new ClaudeCodeAvailabilityProbe(
            new FakeCliProcessRunner(new ProcessResult(127, "", "env: node: No such file or directory", false)),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp" }, locator);

        var result = await probe.ProbeAsync(CancellationToken.None);

        result.ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
        locator.InvalidateCount.Should().Be(1);
    }
}
