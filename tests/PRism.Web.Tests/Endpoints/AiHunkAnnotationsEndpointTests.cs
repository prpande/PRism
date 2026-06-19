using System;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Web.Ai;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 3.2 + § 5.4 + #414. The /ai/hunk-annotations endpoint surfaces ALL annotations for the PR in
// one fetch — calls the per-hunk seam method with empty filePath + 0 hunkIndex sentinels; the placeholder
// ignores them (D109). #414 added the D111 IsSubscribed gate + 503 mapping, verified below against the
// real ClaudeCodeHunkAnnotator seam.
public class AiHunkAnnotationsEndpointTests
{
    [Fact]
    public async Task Get_ai_hunk_annotations_returns_204_when_aiPreview_is_off()
    {
        using var factory = new PRismWebApplicationFactory();
        // Default AiModeState.Mode = Off → Noop seam → 204; set explicitly for clarity. (Off + not-subscribed
        // both yield 204, so this test survives the new gate unchanged.)
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Get_ai_hunk_annotations_returns_200_with_placeholder_entries_when_aiPreview_is_on()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        // The D111 IsSubscribed gate (#414) runs before the seam in every mode. Register a subscriber
        // for this PR so the Preview/Placeholder path is reached (otherwise the gate → 204).
        factory.Services.GetRequiredService<ActivePrSubscriberRegistry>()
            .Add("test-subscriber", new PrReference("octo", "repo", 1));
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().BeGreaterThan(0);
        var first = body[0];
        first.GetProperty("path").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("hunkIndex").GetInt32().Should().BeGreaterOrEqualTo(0);
        first.GetProperty("body").GetString().Should().NotBeNullOrWhiteSpace();
        first.GetProperty("tone").GetString().Should().BeOneOf("calm", "heads-up", "concern");
    }

    [Fact]
    public async Task Get_ai_hunk_annotations_returns_401_without_session_token()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // --- #414: the load-bearing D111 IsSubscribed gate + 503 mapping, verified against the REAL seam. ---

    [Fact]
    public async Task Live_consented_not_subscribed_returns_204_without_invoking_the_annotator()
    {
        using var ctx = new AiHunkAnnotationTestContext(
            annotatorResponse: """[{"path":"a.cs","hunkIndex":0,"body":"n","tone":"calm"}]""",
            subscribeAll: false);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            "the D111 IsSubscribed gate must fire when no subscriber is viewing the PR");
        ctx.AnnotatorProviderCalls.Should().Be(0, "no egress when not subscribed");
    }

    [Fact]
    public async Task Live_consented_subscribed_provider_throws_returns_503()
    {
        using var ctx = new AiHunkAnnotationTestContext(
            annotatorThrows: new LlmProviderException("provider unavailable", "", 1),
            subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable,
            "LlmProviderException must map to 503, never 500 (mirrors /ai/file-focus)");
    }

    [Fact]
    public async Task Live_consented_subscribed_oversized_hunk_returns_503()
    {
        var oversizedBody = new string('x', PromptSanitizer.DefaultMaxChars + 1);
        using var ctx = new AiHunkAnnotationTestContext(
            annotatorResponse: "[]",
            subscribeAll: true,
            hunkBody: oversizedBody);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable,
            "ArgumentException from PromptSanitizer.WrapAsData on an oversized hunk body must map to 503 (not 500)");
    }

    [Fact]
    public async Task Live_consented_subscribed_no_high_medium_returns_204()
    {
        using var ctx = new AiHunkAnnotationTestContext(
            annotatorResponse: "[]",
            subscribeAll: true,
            focusJson: """[{"path":"a.cs","score":"low","rationale":"trivial"}]""");
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent, "no High/Medium files → empty list → 204");
        ctx.AnnotatorProviderCalls.Should().Be(0, "the cost gate excludes the Low file → no annotation call");
    }

    [Fact]
    public async Task Live_consented_subscribed_ok_returns_200_with_body()
    {
        using var ctx = new AiHunkAnnotationTestContext(
            annotatorResponse: """[{"path":"a.cs","hunkIndex":0,"body":"Changes retry backoff.","tone":"heads-up"}]""",
            subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/hunk-annotations", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetArrayLength().Should().Be(1);
        body[0].GetProperty("path").GetString().Should().Be("a.cs");
        body[0].GetProperty("tone").GetString().Should().Be("heads-up");
    }
}

/// <summary>
/// Per-test harness for the /ai/hunk-annotations gate. Replaces the concrete
/// <see cref="ClaudeCodeFileFocusRanker"/> (cost-gate input — provider returns a High score so the file
/// is flagged) AND the concrete <see cref="ClaudeCodeHunkAnnotator"/> (its own provider returns the
/// annotation JSON / throws) so the IAiSeamSelector factory lights up the real annotator as the Live seam.
/// A 204 on the not-subscribed path can then ONLY come from the endpoint gate. Mirrors AiFileFocusTestContext.
///
/// REUSES the file-scoped fakes already in this test assembly/namespace (PRism.Web.Tests.Endpoints):
/// NullTokenTracker / NullAiAuditLog / NullInnerActivePrCache (AiSummaryTestContext.cs) and
/// ConfigurableActivePrCache (PrRootCommentEndpointTests.cs) — do NOT re-declare them. Only CountingProvider
/// (a counting ILlmProvider, per the per-file fake idiom AiFileFocusEndpointTests uses) and FixedConfigStore
/// (no shared IConfigStore stub exists in this namespace) are local.
/// </summary>
internal sealed class AiHunkAnnotationTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;
    private readonly CountingProvider _annotatorProvider;

    public AiModeState ModeState => _derived.Services.GetRequiredService<AiModeState>();
    public AiConsentState ConsentState => _derived.Services.GetRequiredService<AiConsentState>();
    public int AnnotatorProviderCalls => _annotatorProvider.Calls;

    public AiHunkAnnotationTestContext(
        string annotatorResponse = "[]",
        Exception? annotatorThrows = null,
        bool subscribeAll = true,
        string focusJson = """[{"path":"a.cs","score":"high","rationale":"core"}]""",
        string hunkBody = "@@ -1 +1 @@\n+changed")
    {
        var diff = new DiffDto(
            "base..head",
            new[] { new FileChange("a.cs", FileChangeStatus.Modified, new[] { new DiffHunk(1, 1, 1, 1, hunkBody) }) },
            Truncated: false);

        var sharedCache = new NullInnerActivePrCache();   // GetCurrent → null → R7/A2 always proceed
        var sharedBus = new PRism.Core.Events.ReviewEventBus();

        ClaudeCodeFileFocusRanker.DiffResolver rankerResolve = (_, _) => Task.FromResult((diff, "base1", "sha1"));
        var ranker = new ClaudeCodeFileFocusRanker(
            new CountingProvider(focusJson), new NullTokenTracker(), rankerResolve,
            NullLogger<ClaudeCodeFileFocusRanker>.Instance, new NullAiAuditLog(), sharedBus, sharedCache);

        _annotatorProvider = annotatorThrows is not null
            ? CountingProvider.Throwing(annotatorThrows)
            : new CountingProvider(annotatorResponse);
        ClaudeCodeHunkAnnotator.DiffResolver annotatorResolve = (_, _) => Task.FromResult((diff, "base1", "sha1"));
        var annotator = new ClaudeCodeHunkAnnotator(
            _annotatorProvider, new NullTokenTracker(), annotatorResolve,
            NullLogger<ClaudeCodeHunkAnnotator>.Instance, new NullAiAuditLog(), sharedBus, sharedCache,
            ranker, new FixedConfigStore());

        _base = new PRismWebApplicationFactory();
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<ClaudeCodeFileFocusRanker>();
            s.AddSingleton(ranker);
            s.RemoveAll<ClaudeCodeHunkAnnotator>();
            s.AddSingleton(annotator);
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new ConfigurableActivePrCache(subscribeAll));
        }));
        _ = _derived.Services;
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

    // Counts calls + returns the supplied JSON or throws. Used for both the ranker and annotator providers.
    private sealed class CountingProvider : ILlmProvider
    {
        private readonly string _response;
        private readonly Exception? _throw;
        public CountingProvider(string response) => _response = response;
        private CountingProvider(Exception ex) { _throw = ex; _response = string.Empty; }
        public static CountingProvider Throwing(Exception ex) => new(ex);
        public int Calls { get; private set; }
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Calls++;
            if (_throw is not null) throw _throw;
            return Task.FromResult(new LlmResult(_response, 100, 20, 0, 0, 0.01m));
        }
    }

    // Minimal IConfigStore for the annotator's cap read (default 10).
    private sealed class FixedConfigStore : IConfigStore
    {
        public AppConfig Current => AppConfig.Default;
        public string ConfigPath => "/fake/config.json";
        public Exception? LastLoadError => null;
#pragma warning disable CS0067 // test double — the annotator reads Current fresh, never subscribes to Changed
        public event EventHandler<ConfigChangedEventArgs>? Changed;
#pragma warning restore CS0067
        public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
        public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => Task.CompletedTask;
        public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => Task.CompletedTask;
        public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct) => Task.CompletedTask;
    }
}
