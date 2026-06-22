using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliEnvironmentTests
{
    [Fact]
    public void FilterCaptured_keeps_base_and_manager_vars_only()
    {
        var captured = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/opt/homebrew/bin:/usr/bin",
            ["HOME"] = "/Users/x",
            ["TMPDIR"] = "/var/folders/tmp",
            ["VOLTA_HOME"] = "/Users/x/.volta",
            ["NVM_DIR"] = "/Users/x/.nvm",
            ["RANDOM_UNLISTED"] = "nope",
        };

        var env = ClaudeCliEnvironment.FilterCaptured(captured);

        env.Should().ContainKey("PATH");
        env.Should().ContainKey("HOME");
        env.Should().ContainKey("TMPDIR");
        env.Should().ContainKey("VOLTA_HOME");
        env.Should().ContainKey("NVM_DIR");
        env.Should().NotContainKey("RANDOM_UNLISTED");
    }

    [Fact]
    public void FilterCaptured_strips_credential_redirect_and_node_option_vars()
    {
        var captured = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/usr/bin",
            ["ANTHROPIC_API_KEY"] = "sk-leak",
            ["ANTHROPIC_BASE_URL"] = "http://evil",
            ["HTTPS_PROXY"] = "http://evil",
            ["NO_PROXY"] = "localhost",
            ["CLAUDE_CONFIG_DIR"] = "/tmp/evil",
            ["NODE_OPTIONS"] = "--require /tmp/evil.js",
            ["NODE_EXTRA_CA_CERTS"] = "/tmp/evil.pem",
        };

        var env = ClaudeCliEnvironment.FilterCaptured(captured);

        env.Keys.Should().BeEquivalentTo(new[] { "PATH" });
    }

    [SkippableFact]
    public void FilterCaptured_is_case_sensitive_on_posix()
    {
        Skip.If(OperatingSystem.IsWindows(), "POSIX env vars are case-sensitive; Windows is not.");
        var captured = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/usr/bin",
            ["nvm_dir"] = "/should/not/match",   // lowercase must NOT be treated as NVM_DIR
        };

        var env = ClaudeCliEnvironment.FilterCaptured(captured);

        env.Should().NotContainKey("nvm_dir");
        env.Should().NotContainKey("NVM_DIR");
    }

    [Fact]
    public void Base_allowlist_includes_tmpdir()
    {
        ClaudeCliEnvironment.Allowlist.Should().Contain("TMPDIR");
    }
}
