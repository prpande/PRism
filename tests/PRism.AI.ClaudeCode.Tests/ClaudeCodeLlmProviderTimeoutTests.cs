using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;
using Xunit;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeLlmProviderTimeoutTests
{
    private static readonly ProcessResult Ok = new(
        ExitCode: 0,
        Stdout: """{ "result": "ok", "total_cost_usd": 0 }""",
        Stderr: "",
        TimedOut: false);

    private static LlmRequest Req() => new("s", "u", "claude-x");

    [Fact]
    public async Task TimeoutProvider_is_evaluated_per_call()
    {
        var seconds = 100;
        var runner = new FakeCliProcessRunner(Ok);
        var options = new ClaudeCodeProviderOptions
        {
            WorkingDirectory = Path.GetTempPath(),
            TimeoutProvider = () => TimeSpan.FromSeconds(seconds),
        };
        var locator = new FakeClaudeCliLocator(new ResolvedCli("claude", ClaudeCliEnvironment.BuildAllowlisted()));
        var provider = new ClaudeCodeLlmProvider(runner, options, locator);

        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.Timeout.Should().Be(TimeSpan.FromSeconds(100));

        seconds = 300;
        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.Timeout.Should().Be(TimeSpan.FromSeconds(300));
    }

    [Fact]
    public async Task Default_TimeoutProvider_returns_static_Timeout()
    {
        var runner = new FakeCliProcessRunner(Ok);
        var options = new ClaudeCodeProviderOptions
        {
            WorkingDirectory = Path.GetTempPath(),
            Timeout = TimeSpan.FromSeconds(77),
        };
        var locator = new FakeClaudeCliLocator(new ResolvedCli("claude", ClaudeCliEnvironment.BuildAllowlisted()));
        var provider = new ClaudeCodeLlmProvider(runner, options, locator);

        await provider.CompleteAsync(Req(), CancellationToken.None);
        runner.Captured!.Timeout.Should().Be(TimeSpan.FromSeconds(77));
    }
}
