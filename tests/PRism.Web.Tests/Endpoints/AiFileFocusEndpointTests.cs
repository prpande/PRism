using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Dtos;
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

// Spec § 3.2 + § 5.4. The /ai/file-focus endpoint mirrors /ai/summary's
// seam-resolve-and-map pattern: Noop seam → empty list → 204; Placeholder
// seam → canned data → 200. An IsSubscribed gate (D111) fires before
// RankAsync in every mode; Task 5 added it and the tests below verify it.
public class AiFileFocusEndpointTests
{
    [Fact]
    public async Task Get_ai_file_focus_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        // Default AiModeState.Mode = Off → Noop seam → 204; set explicitly for clarity.
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_file_focus_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        // Task 5 added the D111 IsSubscribed gate that runs before the seam in every mode. Register a
        // subscriber for this PR so the Preview/Placeholder path is reached (otherwise the gate → 204).
        factory.Services.GetRequiredService<ActivePrSubscriberRegistry>()
            .Add("test-subscriber", new PrReference("octo", "repo", 1));
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("entries").GetArrayLength().Should().BeGreaterThan(0);
        var first = body.GetProperty("entries")[0];
        first.GetProperty("path").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("level").GetString().Should().BeOneOf("high", "medium", "low");
        first.GetProperty("rationale").GetString().Should().NotBeNullOrWhiteSpace();
        body.GetProperty("fallback").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Get_ai_file_focus_returns_401_without_session_token()
    {
        // Spec § 5.4: per-route spot-check that SessionTokenMiddleware covers
        // the new endpoint. Catches accidental middleware exemption widening
        // (a la /api/health) for the /ai/* family.
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // --- Task 5: the load-bearing IsSubscribed gate, verified against the REAL seam ---
    //
    // These cases register a genuine ClaudeCodeFileFocusRanker (not Noop, not a stub IFileFocusRanker)
    // as the Live seam — exactly as AiSummaryTestContext lights up the real ClaudeCodeSummarizer — so a
    // 204 on the not-subscribed path can ONLY come from the endpoint gate, never from a Noop's own empty
    // result. The ranker is built with a counting DiffResolver; RankAsync calls that resolver as its very
    // first statement, so resolver.Calls == 0 proves RankAsync was never entered (the gate short-circuited
    // BEFORE ai.Resolve<IFileFocusRanker>()/RankAsync). This is the counting-ranker proof the plan asks for,
    // routed through the production sealed type rather than a wrapper.

    [Fact]
    public async Task Live_consented_not_subscribed_returns_204_without_invoking_the_real_ranker()
    {
        var provider = new FakeOkFileFocusProvider();
        using var ctx = new AiFileFocusTestContext(
            provider,
            diff: SingleFileDiff(),
            subscribeAll: false);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "the D111 IsSubscribed gate must fire when no subscriber is viewing the PR");
        ctx.ResolverCalls.Should().Be(0,
            "the gate must short-circuit BEFORE RankAsync — RankAsync resolves the diff first, so a 0 " +
            "resolver-call count proves the real ranker was never reached (not shadowed by a Noop 204)");
        provider.Calls.Should().Be(0, "no provider egress when not subscribed");
    }

    [Fact]
    public async Task Live_consented_subscribed_provider_throws_returns_503()
    {
        var provider = FakeOkFileFocusProvider.Throwing(
            new LlmProviderException("provider unavailable", "", 1));
        using var ctx = new AiFileFocusTestContext(
            provider,
            diff: SingleFileDiff(),
            subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable,
            "LlmProviderException must be mapped to 503, never 500 (mirrors /ai/summary)");
    }

    [Fact]
    public async Task Live_consented_subscribed_oversized_hunk_returns_503()
    {
        // PromptSanitizer.WrapAsData throws ArgumentException when a single file's hunk bodies exceed
        // the 2 MB cap. Verify the endpoint maps that to 503, not 500.
        var oversizedBody = new string('x', PromptSanitizer.DefaultMaxChars + 1);
        var oversizedDiff = new DiffDto(
            "base..head",
            new[] { new FileChange("a.cs", FileChangeStatus.Modified, new[] { new DiffHunk(1, 1, 1, 1, oversizedBody) }) },
            Truncated: false);
        var provider = new FakeOkFileFocusProvider(); // won't be reached
        using var ctx = new AiFileFocusTestContext(
            provider,
            diff: oversizedDiff,
            subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable,
            "ArgumentException from PromptSanitizer.WrapAsData on oversized hunk bodies must map to 503 (not 500)");
        provider.Calls.Should().Be(0, "ArgumentException is thrown before the provider is called");
    }

    [Fact]
    public async Task Live_consented_subscribed_empty_diff_returns_204()
    {
        var provider = new FakeOkFileFocusProvider();
        using var ctx = new AiFileFocusTestContext(
            provider,
            diff: new DiffDto("base..head", Array.Empty<FileChange>(), Truncated: false),
            subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "an empty diff yields an empty Entries list → 204 (the endpoint's empty-result arm)");
        provider.Calls.Should().Be(0, "no rankable files → no provider call");
    }

    [Fact]
    public async Task Live_consented_subscribed_ok_returns_200_with_envelope()
    {
        var provider = new FakeOkFileFocusProvider(
            """[{"path":"a.cs","score":"high","rationale":"core logic"}]""");
        using var ctx = new AiFileFocusTestContext(
            provider,
            diff: SingleFileDiff(),
            subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/file-focus", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK, "all gates open + provider succeeds → 200");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var entries = body.GetProperty("entries");
        entries.GetArrayLength().Should().BeGreaterThan(0);
        entries[0].GetProperty("path").GetString().Should().Be("a.cs");
        entries[0].GetProperty("level").GetString().Should().Be("high");
        entries[0].GetProperty("rationale").GetString().Should().Be("core logic");
        body.GetProperty("fallback").GetBoolean().Should().BeFalse();
    }

    private static DiffDto SingleFileDiff() => new(
        "base..head",
        new[] { new FileChange("a.cs", FileChangeStatus.Modified, new[] { new DiffHunk(1, 1, 1, 1, "@@ -1 +1 @@\n+x") }) },
        Truncated: false);

    // Scriptable ILlmProvider for the file-focus gate cases. Returns the supplied JSON (or throws) and
    // counts calls so the not-subscribed/empty-diff cases can assert zero egress.
    private sealed class FakeOkFileFocusProvider : ILlmProvider
    {
        private readonly string _response;
        private readonly Exception? _throw;

        public FakeOkFileFocusProvider(string response = "[]") => _response = response;
        private FakeOkFileFocusProvider(Exception ex)
        {
            _throw = ex;
            _response = string.Empty;
        }

        public static FakeOkFileFocusProvider Throwing(Exception ex) => new(ex);

        public int Calls { get; private set; }

        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Calls++;
            if (_throw is not null)
                throw _throw;
            return Task.FromResult(new LlmResult(_response, 100, 20, 0, 0, 0.01m));
        }
    }
}

/// <summary>
/// Per-test harness for the /ai/file-focus endpoint gate. Mirrors <see cref="AiSummaryTestContext"/>:
/// replaces the concrete <see cref="ClaudeCodeFileFocusRanker"/> singleton with one built from a stub
/// provider + a counting <see cref="ClaudeCodeFileFocusRanker.DiffResolver"/> (no <c>PrDetailLoader</c>),
/// so the IAiSeamSelector factory lights it up as the Live <c>realSeams[typeof(IFileFocusRanker)]</c> entry.
/// The counting resolver lets the not-subscribed case prove RankAsync was never invoked.
/// </summary>
internal sealed class AiFileFocusTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;
    private int _resolverCalls;

    public AiModeState ModeState => _derived.Services.GetRequiredService<AiModeState>();
    public AiConsentState ConsentState => _derived.Services.GetRequiredService<AiConsentState>();
    public int ResolverCalls => Volatile.Read(ref _resolverCalls);

    public AiFileFocusTestContext(ILlmProvider provider, DiffDto diff, bool subscribeAll)
    {
        ClaudeCodeFileFocusRanker.DiffResolver resolve = (_, _) =>
        {
            Interlocked.Increment(ref _resolverCalls);
            return Task.FromResult((diff, "base1", "sha1"));
        };
        var ranker = new ClaudeCodeFileFocusRanker(
            provider, new NullTokenTracker(), resolve,
            NullLogger<ClaudeCodeFileFocusRanker>.Instance, new NullAiAuditLog(),
            new ReviewEventBus(), new NullInnerActivePrCache());

        _base = new PRismWebApplicationFactory();
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            // Replace the concrete ClaudeCodeFileFocusRanker so the IAiSeamSelector factory's
            // sp.GetRequiredService<ClaudeCodeFileFocusRanker>() returns our counting instance —
            // it becomes realSeams[typeof(IFileFocusRanker)], the Live seam.
            s.RemoveAll<ClaudeCodeFileFocusRanker>();
            s.AddSingleton(ranker);

            // Replace IActivePrCache so the D111 gate behaves per-case.
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new ConfigurableActivePrCache(subscribeAll));
        }));
        _ = _derived.Services; // force the container build
    }

    public HttpClient CreateClient()
    {
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
