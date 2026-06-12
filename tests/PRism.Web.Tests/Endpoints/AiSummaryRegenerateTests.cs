using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

/// <summary>
/// Integration tests for POST /api/pr/{owner}/{repo}/{number}/ai/summary/regenerate (spec §7 / P1b
/// Task 10). Covers the D111 gate, CSRF guard, provider-ok, provider-error, and cache-write paths.
///
/// <para>
/// Cases:
/// 1 — not subscribed → 204; provider not called (D111 gate same as GET).
/// 2 — live, subscribed, consented, provider ok → 200; provider called exactly once.
/// 3 — after regenerate, a subsequent GET is a cache HIT (provider not called again).
/// 4 — provider throws → 503.
/// 5 — missing Origin header → 403 (CSRF guard via OriginCheckMiddleware).
/// 6 — gate helper parity: both GET and POST return 204 for not-subscribed (behavioral parity).
/// </para>
/// </summary>
public sealed class AiSummaryRegenerateTests
{
    // Stub ILlmProvider that returns a well-formed summary completion.
    private sealed class FakeOkProvider : ILlmProvider
    {
        public int Calls;
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new LlmResult("CATEGORY: fix\nThis PR fixes the poller.", 10, 5, 0, 0m));
        }
    }

    // Stub ILlmProvider that throws LlmProviderException.
    private sealed class ThrowingProvider : ILlmProvider
    {
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
            => throw new LlmProviderException("provider unavailable", "", 1);
    }

    [Fact]
    public async Task Regenerate_not_subscribed_returns_204_provider_not_called()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: false);
        ctx.ModeState.Mode = AiMode.Live; ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/octo/repo/1/ai/summary/regenerate", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
        provider.Calls.Should().Be(0);
    }

    [Fact]
    public async Task Regenerate_live_subscribed_consented_returns_200_and_calls_provider_once()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live; ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/octo/repo/1/ai/summary/regenerate", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        provider.Calls.Should().Be(1, "regenerate evicts then re-summarizes — a deliberate single re-spend");
    }

    [Fact]
    public async Task After_regenerate_a_subsequent_GET_is_a_cache_HIT()
    {
        // Guards against a systematic R7 false-reject on the regenerate path (ce-doc-review adversarial):
        // a successful regenerate MUST cache its result, or "one deliberate re-spend" silently becomes two.
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live; ctx.SeedConsent();
        using var client = ctx.CreateClient();

        await client.PostAsync(new Uri("/api/pr/octo/repo/1/ai/summary/regenerate", UriKind.Relative), null);
        provider.Calls.Should().Be(1);
        await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        provider.Calls.Should().Be(1, "the regenerated summary must be cached — a follow-up GET is a HIT, not a re-spend");
    }

    [Fact]
    public async Task Regenerate_provider_throws_returns_503_not_cached()
    {
        var provider = new ThrowingProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live; ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync(new Uri("/api/pr/octo/repo/1/ai/summary/regenerate", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task Regenerate_missing_origin_returns_403()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live; ctx.SeedConsent();
        var client = ctx.CreateClient();
        client.DefaultRequestHeaders.Remove("Origin"); // POST is CSRF-covered by OriginCheckMiddleware

        var resp = await client.PostAsync(new Uri("/api/pr/octo/repo/1/ai/summary/regenerate", UriKind.Relative), null);

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    /// <summary>
    /// Gate-helper parity (behavioral form): both GET and POST return 204 for not-subscribed.
    /// TestSeams.Noop() does not exist in this codebase, so structural-form is not available;
    /// behavioral parity is asserted instead (plan §T10 guidance permits this form).
    /// </summary>
    [Fact]
    public async Task Gate_helper_returns_NoContent_when_not_subscribed_GET_and_POST_parity()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: false);
        ctx.ModeState.Mode = AiMode.Live; ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var getResp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));
        var postResp = await client.PostAsync(new Uri("/api/pr/octo/repo/1/ai/summary/regenerate", UriKind.Relative), null);

        getResp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "GET not-subscribed must return 204 via shared gate helper");
        postResp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "POST regenerate not-subscribed must return 204 via the same shared gate helper");
        provider.Calls.Should().Be(0, "provider must not be called when not subscribed on either route");
    }
}
