using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.Core.Ai;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #606: a clean exit (0) + malformed `claude -p` stdout must surface as 503 on /ai/summary — never 500.
// Unlike AiEndpointsFailureReasonTests (which hand-throws LlmProviderException), this wires the REAL
// ClaudeCodeLlmProvider behind a stub runner returning garbage stdout, so it exercises the full trace
// the bug lives on:  Deserialize → (fixed) LlmProviderException → summarizer rethrow → AiEndpoints → 503.
// On origin/main, Deserialize throws a raw JsonException that AiEndpoints does not catch → 500 (RED).
public class AiSummaryMalformedStdoutTests
{
    private sealed class StubRunner(ProcessResult result) : ICliProcessRunner
    {
        public Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken ct) => Task.FromResult(result);
    }

    // The provider calls ResolveAsync once and never InvalidateResolved on the exit-0 path; a bare
    // launchable with an empty env is sufficient (the stub runner ignores both path and env).
    private sealed class StubLocator : IClaudeCliLocator
    {
        private static readonly ClaudeCliResolution Resolved =
            new ResolvedCli("claude", new Dictionary<string, string>());
        public Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct) => Task.FromResult(Resolved);
        public ClaudeCliResolution? CurrentResolved => Resolved;
        public void InvalidateResolved() { }
    }

    [Fact]
    public async Task Malformed_stdout_returns_503_provider_error_not_500()
    {
        // clean exit, garbage stdout: a CLI banner line prepended to a truncated JSON object.
        var provider = new ClaudeCodeLlmProvider(
            new StubRunner(new ProcessResult(0, "claude: starting\n{ \"result\": \"trunc", "", false)),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\ProgramData\PRism\llm-cwd" },
            new StubLocator());

        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("reason").GetString().Should().Be("provider-error");
    }
}
