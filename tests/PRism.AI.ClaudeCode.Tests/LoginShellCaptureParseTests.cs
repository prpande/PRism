using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class LoginShellCaptureParseTests
{
    private const string S1 = "S1-aaa";
    private const string S2 = "S2-bbb";
    private const string S3 = "S3-ccc";

    private static string Wrap(string commandV, string envBlock, string banner = "") =>
        $"{banner}{S1}\n{commandV}\n{S2}\n{envBlock}\n{S3}\n";

    [Fact]
    public void Parses_command_v_and_env_block()
    {
        var stdout = Wrap(
            commandV: "/opt/homebrew/bin/claude",
            envBlock: "PATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/x\nVOLTA_HOME=/Users/x/.volta");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().NotBeNull();
        cap!.CommandVClaude.Should().Be("/opt/homebrew/bin/claude");
        cap.Environment["PATH"].Should().Be("/opt/homebrew/bin:/usr/bin");
        cap.Environment["VOLTA_HOME"].Should().Be("/Users/x/.volta");
    }

    [Fact]
    public void Ignores_banner_noise_before_first_sentinel()
    {
        var stdout = Wrap(
            commandV: "/usr/local/bin/claude",
            envBlock: "PATH=/usr/local/bin",
            banner: "Welcome to zsh!\nLast login: yesterday\n");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().NotBeNull();
        cap!.CommandVClaude.Should().Be("/usr/local/bin/claude");
    }

    [Fact]
    public void Null_command_v_when_claude_not_found()
    {
        var stdout = Wrap(commandV: "", envBlock: "PATH=/usr/bin");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().NotBeNull();
        cap!.CommandVClaude.Should().BeNull();
        cap.Environment.Should().ContainKey("PATH");
    }

    [Fact]
    public void Returns_null_when_sentinels_missing()
    {
        var stdout = "no sentinels here at all\nPATH=/usr/bin\n";

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().BeNull();
    }

    [Fact]
    public void Env_value_may_contain_equals_sign()
    {
        var stdout = Wrap(
            commandV: "/usr/bin/claude",
            envBlock: "PATH=/usr/bin\nLS_COLORS=di=34:ln=35");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap!.Environment["LS_COLORS"].Should().Be("di=34:ln=35");
    }

    [Fact]
    public void Rejects_interleaved_non_env_lines_in_env_block()
    {
        // A prompt-framework status line / escape sequence with '=' interleaved in the env region
        // must not inject a key or corrupt PATH.
        var stdout = Wrap(
            commandV: "/usr/bin/claude",
            envBlock: "PATH=/usr/bin\n[1;32m status here=bogus\nVOLTA_HOME=/v");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap!.Environment["PATH"].Should().Be("/usr/bin");
        cap.Environment["VOLTA_HOME"].Should().Be("/v");
        cap.Environment.Should().HaveCount(2);   // the escape-prefixed line is dropped
    }
}
