using System.ComponentModel;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeLlmProviderTests
{
    private static readonly ProcessResult Ok = new(
        ExitCode: 0,
        Stdout: """{ "result": "hi", "session_id": "s", "total_cost_usd": 0.001, "usage": { "input_tokens": 10, "output_tokens": 2, "cache_read_input_tokens": 0 } }""",
        Stderr: "",
        TimedOut: false);

    private static (ClaudeCodeLlmProvider provider, FakeCliProcessRunner runner) Build(ProcessResult? result = null)
    {
        var runner = new FakeCliProcessRunner(result ?? Ok);
        var locator = new FakeClaudeCliLocator(new ResolvedCli("claude", ClaudeCliEnvironment.BuildAllowlisted()));
        var provider = new ClaudeCodeLlmProvider(runner, new ClaudeCodeProviderOptions
        {
            WorkingDirectory = @"C:\ProgramData\PRism\llm-cwd",
        }, locator);
        return (provider, runner);
    }

    private static LlmRequest Req() => new("SYS", "USER", "claude-opus-4-8");

    [Fact]
    public async Task Never_passes_bare_flag()
    {
        var (provider, runner) = Build();
        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.Arguments.Should().NotContain("--bare");
    }

    [Fact]
    public async Task Passes_print_json_model_and_exclude_dynamic_sections()
    {
        var (provider, runner) = Build();
        await provider.CompleteAsync(Req(), CancellationToken.None);
        var args = runner.Captured!.Arguments;
        args.Should().Contain("-p");
        args.Should().ContainInOrder("--output-format", "json");
        args.Should().ContainInOrder("--model", "claude-opus-4-8");
        args.Should().Contain("--exclude-dynamic-system-prompt-sections");
    }

    [Fact]
    public async Task Disables_all_tools()
    {
        var (provider, runner) = Build();
        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.Arguments.Should().ContainInOrder("--tools", "");
    }

    [Fact]
    public async Task Env_allowlist_excludes_auth_and_redirect_vars()
    {
        var (provider, runner) = Build();
        await provider.CompleteAsync(Req(), CancellationToken.None);
        var env = runner.Captured!.Environment;
        env.Keys.Should().NotContain(new[]
        {
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "HTTP_PROXY", "HTTPS_PROXY",
        });
    }

    [Fact]
    public async Task Does_not_forward_CLAUDE_CONFIG_DIR_from_parent()
    {
        // CLAUDE_CONFIG_DIR is a credential-redirect vector — it must NOT be forwarded from the parent env.
        Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", @"C:\attacker-config");
        try
        {
            var (provider, runner) = Build();
            await provider.CompleteAsync(Req(), CancellationToken.None);
            runner.Captured!.Environment.Keys.Should().NotContain("CLAUDE_CONFIG_DIR");
        }
        finally { Environment.SetEnvironmentVariable("CLAUDE_CONFIG_DIR", null); }
    }

    [Fact]
    public async Task Runs_in_the_configured_stable_cwd()
    {
        var (provider, runner) = Build();
        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.WorkingDirectory.Should().Be(@"C:\ProgramData\PRism\llm-cwd");
    }

    [Fact]
    public async Task System_prompt_via_append_and_user_content_via_stdin()
    {
        var (provider, runner) = Build();
        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.Arguments.Should().Contain("--append-system-prompt");
        runner.Captured.StdinText.Should().Be("USER");
    }

    [Fact]
    public async Task Maps_envelope_to_result_including_cache_read()
    {
        var (provider, _) = Build(new ProcessResult(0,
            """{ "result": "done", "session_id": "s", "total_cost_usd": 0.5, "usage": { "input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 80 } }""",
            "", false));
        var result = await provider.CompleteAsync(Req(), CancellationToken.None);
        result.Text.Should().Be("done");
        result.CacheReadInputTokens.Should().Be(80);
        result.EstimatedCostUsd.Should().Be(0.5m);
    }

    [Fact]
    public async Task Maps_cache_creation_input_tokens_from_envelope()
    {
        // #379: on a cold call the claude-code CLI prompt-caches the bulk of the prompt, so almost all
        // input volume is billed as cache_creation_input_tokens while input_tokens is a rounding-error.
        // Shape is a real captured payload (89,414 cache-creation tokens for an ~80KB prompt, input_tokens 9).
        var (provider, _) = Build(new ProcessResult(0,
            """{ "result": "done", "session_id": "s", "total_cost_usd": 0.18, "usage": { "input_tokens": 9, "cache_creation_input_tokens": 89414, "cache_read_input_tokens": 0, "output_tokens": 301 } }""",
            "", false));
        var result = await provider.CompleteAsync(Req(), CancellationToken.None);
        result.InputTokens.Should().Be(9);
        result.CacheCreationInputTokens.Should().Be(89414);
        result.CacheReadInputTokens.Should().Be(0);
    }

    [Fact]
    public async Task Nonzero_exit_throws_LlmProviderException_with_stderr()
    {
        var (provider, _) = Build(new ProcessResult(1, "", "Not logged in · Please run /login", false));
        var act = async () => await provider.CompleteAsync(Req(), CancellationToken.None);
        (await act.Should().ThrowAsync<LlmProviderException>())
            .Which.Stderr.Should().Contain("Not logged in");
    }

    [Fact]
    public async Task Timeout_throws_LlmProviderException()
    {
        var (provider, _) = Build(new ProcessResult(-1, "", "", TimedOut: true));
        var act = async () => await provider.CompleteAsync(Req(), CancellationToken.None);
        await act.Should().ThrowAsync<LlmProviderException>();
    }

    [Fact]
    public async Task Missing_cli_Win32Exception_surfaces_as_LlmProviderException()
    {
        var runner = new FakeCliProcessRunner(new Win32Exception("The system cannot find the file specified"));
        var locator = new FakeClaudeCliLocator(new ResolvedCli("claude", ClaudeCliEnvironment.BuildAllowlisted()));
        var provider = new ClaudeCodeLlmProvider(runner, new ClaudeCodeProviderOptions
        {
            WorkingDirectory = @"C:\ProgramData\PRism\llm-cwd",
        }, locator);
        var act = async () => await provider.CompleteAsync(Req(), CancellationToken.None);
        await act.Should().ThrowAsync<LlmProviderException>();
    }

    [Fact]
    public async Task Result_field_absent_throws()
    {
        // Valid JSON, exit 0, but no "result" field (a future/error CLI shape) — must NOT be a silent empty success.
        var (provider, _) = Build(new ProcessResult(0, """{ "session_id": "s", "total_cost_usd": 0.0 }""", "", false));
        var act = async () => await provider.CompleteAsync(Req(), CancellationToken.None);
        await act.Should().ThrowAsync<LlmProviderException>();
    }

    [Fact]
    public async Task Result_present_but_empty_returns_empty_text()
    {
        // A model may legitimately return an empty completion — present-but-empty is NOT an error.
        var (provider, _) = Build(new ProcessResult(0, """{ "result": "", "session_id": "s", "total_cost_usd": 0.0 }""", "", false));
        var result = await provider.CompleteAsync(Req(), CancellationToken.None);
        result.Text.Should().BeEmpty();
    }

    [Fact]
    public async Task Exception_stderr_is_redacted_and_truncated()
    {
        var secret = "Bearer sk-ant-0123456789abcdef0123456789abcdef token=deadbeefdeadbeefdeadbeefdeadbeef ";
        var (provider, _) = Build(new ProcessResult(1, "", secret + new string('a', 1000), false));
        var ex = (await ((Func<Task>)(async () => await provider.CompleteAsync(Req(), CancellationToken.None)))
            .Should().ThrowAsync<LlmProviderException>()).Which;
        ex.Stderr.Length.Should().BeLessThanOrEqualTo(512);
        ex.Stderr.Should().NotContain("sk-ant-0123456789abcdef0123456789abcdef");
    }

    [Fact]
    public async Task Exception_stderr_redacts_bare_anthropic_key()
    {
        // A bare sk-ant key (no Bearer/token= prefix) printed in stderr must still be redacted.
        const string bareKey = "error: invalid key sk-ant-api03-AbCdEf0123456789_-XyZ rejected";
        var (provider, _) = Build(new ProcessResult(1, "", bareKey, false));
        var ex = (await ((Func<Task>)(async () => await provider.CompleteAsync(Req(), CancellationToken.None)))
            .Should().ThrowAsync<LlmProviderException>()).Which;
        ex.Stderr.Should().NotContain("sk-ant-");
    }
}
