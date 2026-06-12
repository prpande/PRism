using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Observability;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Web.Ai;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

/// <summary>
/// Integration tests for the D111 active-subscriber gate and 503 provider-failure mapping on
/// GET /api/pr/{owner}/{repo}/{number}/ai/summary (spec §6 + §7 + §9).
///
/// <para>
/// Five cases:
/// A — mode=live, consented, NOT subscribed → 204; provider not called (D111 gate).
/// B — mode=live, subscribed, NOT consented → 204; provider not called (consent gate via Noop).
/// C — mode=live, subscribed, consented, provider ok → 200 + { body, category }.
/// D — mode=live, subscribed, consented, provider throws LlmProviderException → 503.
/// E — mode=off → 204. (Default is Preview per PR #283; Off must be set explicitly.)
/// </para>
/// </summary>
public sealed class AiSummaryGateTests
{
    // Stub ILlmProvider that returns a well-formed summary completion (CATEGORY line first).
    private sealed class FakeOkProvider : ILlmProvider
    {
        public int Calls;
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new LlmResult("CATEGORY: fix\nThis PR fixes the poller.", 10, 5, 0, 0m));
        }
    }

    // Stub ILlmProvider that throws LlmProviderException — drives case D.
    private sealed class ThrowingProvider : ILlmProvider
    {
        public int Calls;
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Calls++;
            throw new LlmProviderException("provider unavailable", "", 1);
        }
    }

    // No-op ITokenUsageTracker (non-fatal, spec §9).
    private sealed class NullTracker : ITokenUsageTracker
    {
        public Task RecordAsync(TokenUsageRecord record, CancellationToken ct) => Task.CompletedTask;
    }

    // No-op AI audit sink — these gate tests assert HTTP status mapping, not audit logging.
    private sealed class NullAiInteractionLog : IAiInteractionLog
    {
        public void Record(AiInteractionRecord record) { }
    }

    // Permissive IActivePrCache for the stub summarizer: null snapshot → R7 store always proceeds.
    // Gate tests assert HTTP status, not caching; this avoids a cross-test-project dependency on
    // ClaudeCodeSummarizerTests.StubActivePrCache.
    private sealed class NullActivePrCache : IActivePrCache
    {
        public bool IsSubscribed(PrReference prRef) => true;
        public ActivePrSnapshot? GetCurrent(PrReference prRef) => null;
        public void Update(PrReference prRef, ActivePrSnapshot snapshot) { }
        public void Clear() { }
    }

    /// <summary>
    /// Per-test harness. Wires a stubbed ClaudeCodeSummarizer (no PrDetailLoader dependency)
    /// and a ConfigurableActivePrCache. Mirrors RootCommentTestContext's pattern so the
    /// session token is properly injected into the HTTP client.
    /// </summary>
    private sealed class AiSummaryTestContext : IDisposable
    {
        private readonly PRismWebApplicationFactory _base;
        private readonly WebApplicationFactory<Program> _derived;

        public AiModeState ModeState => _derived.Services.GetRequiredService<AiModeState>();
        public AiConsentState ConsentState => _derived.Services.GetRequiredService<AiConsentState>();

        public AiSummaryTestContext(ILlmProvider provider, bool subscribeAll)
        {
            var stubSummarizer = new ClaudeCodeSummarizer(
                provider, new NullTracker(),
                (_, _) => Task.FromResult(("+ added", "Title", "Desc", "base1", "sha1")),
                NullLogger<ClaudeCodeSummarizer>.Instance, new NullAiInteractionLog(),
                new PRism.Core.Events.ReviewEventBus(), // fresh bus — see note
                new NullActivePrCache());

            _base = new PRismWebApplicationFactory();
            _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
            {
                // Replace ClaudeCodeSummarizer with a stub that avoids PrDetailLoader.
                // The IAiSeamSelector factory calls sp.GetRequiredService<ClaudeCodeSummarizer>()
                // to populate realSeams — replacing it here causes the stub to light up as the
                // Live seam without needing a real PR diff load path.
                s.RemoveAll<ClaudeCodeSummarizer>();
                s.AddSingleton(stubSummarizer);

                // Replace IActivePrCache so the D111 gate behaves per-case.
                s.RemoveAll<IActivePrCache>();
                s.AddSingleton<IActivePrCache>(new ConfigurableActivePrCache(subscribeAll));
            }));
            // Force DI container build so services are available before tests access them.
            _ = _derived.Services;
        }

        public HttpClient CreateClient()
        {
            // Mirror PRismWebApplicationFactory.ConfigureClient: inject session token + origin.
            var token = _derived.Services.GetRequiredService<SessionTokenProvider>().Current;
            var c = _derived.CreateClient();
            c.DefaultRequestHeaders.Add("X-PRism-Session", token);
            c.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
            var origin = c.BaseAddress?.GetLeftPart(UriPartial.Authority);
            if (!string.IsNullOrEmpty(origin)) c.DefaultRequestHeaders.Add("Origin", origin);
            return c;
        }

        public void SeedConsent()
            => ConsentState.Set(new AiConsentConfig(
                AiProviderIds.Claude, AiDisclosure.CurrentVersion, DateTimeOffset.UtcNow));

        public void Dispose()
        {
            _derived.Dispose();
            _base.Dispose();
        }
    }

    // --- Case A ---
    [Fact]
    public async Task A_Live_consented_not_subscribed_returns_204_provider_not_called()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: false);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "D111 gate must fire when no subscriber is viewing the PR");
        provider.Calls.Should().Be(0, "provider must not be called when not subscribed");
    }

    // --- Case B ---
    [Fact]
    public async Task B_Live_subscribed_no_consent_returns_204_provider_not_called()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        // Deliberately do NOT seed consent — selector returns Noop → SummarizeAsync returns null → 204.
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "consent gate must block the real summarizer when consent is absent");
        provider.Calls.Should().Be(0, "Noop summarizer must not call through to the provider");
    }

    // --- Case C ---
    [Fact]
    public async Task C_Live_subscribed_consented_provider_ok_returns_200_with_body_and_category()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK, "all gates open + provider succeeds → 200");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
        body.GetProperty("category").GetString().Should().Be("fix");
    }

    // --- Case D ---
    [Fact]
    public async Task D_Live_subscribed_consented_provider_throws_returns_503()
    {
        var provider = new ThrowingProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable,
            "LlmProviderException must be mapped to 503, never 500 (spec §7/§9)");
    }

    // --- Case E ---
    [Fact]
    public async Task E_Off_returns_204()
    {
        var provider = new FakeOkProvider();
        using var ctx = new AiSummaryTestContext(provider, subscribeAll: true);
        // AiMode.Off must be set explicitly — default is Preview (PR #283 flipped AppConfig.Default).
        ctx.ModeState.Mode = AiMode.Off;
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent, "mode=Off → Noop summarizer → null → 204");
        provider.Calls.Should().Be(0, "Noop summarizer must not reach the provider");
    }
}
