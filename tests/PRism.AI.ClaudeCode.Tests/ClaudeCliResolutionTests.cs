using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliResolutionTests
{
    [Fact]
    public void ResolvedCli_carries_path_and_env()
    {
        var env = new Dictionary<string, string> { ["PATH"] = "/usr/bin" };
        ClaudeCliResolution res = new ResolvedCli("/opt/homebrew/bin/claude", env);

        res.Should().BeOfType<ResolvedCli>()
            .Which.ExecutablePath.Should().Be("/opt/homebrew/bin/claude");
        ((ResolvedCli)res).Environment.Should().ContainKey("PATH");
    }

    [Fact]
    public void NotFound_carries_reason_code()
    {
        ClaudeCliResolution res = new NotFound(ClaudeReasonCodes.CliDiscoveryFailed);
        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be("cli-discovery-failed");
    }
}
