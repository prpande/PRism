using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;             // LlmProviderException
using PRism.AI.Contracts.Provider;     // ILlmProvider, LlmRequest, LlmResult
using PRism.Core.Ai;                   // AiMode
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class AiEndpointsFailureReasonTests
{
    private sealed class ThrowingLlmProvider(bool timedOut) : ILlmProvider
    {
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            throw new LlmProviderException("boom", stderr: "", exitCode: -1, timedOut: timedOut);
    }

    private static async Task<JsonElement> SummaryFailureBody(bool timedOut)
    {
        using var ctx = new AiSummaryTestContext(new ThrowingLlmProvider(timedOut), subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        return await resp.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Timeout_failure_returns_503_with_reason_timeout() =>
        (await SummaryFailureBody(timedOut: true)).GetProperty("reason").GetString().Should().Be("timeout");

    [Fact]
    public async Task Generic_provider_failure_returns_503_with_reason_provider_error() =>
        (await SummaryFailureBody(timedOut: false)).GetProperty("reason").GetString().Should().Be("provider-error");
}
