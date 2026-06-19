using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.AI.Contracts.Observability;
using PRism.Core.Ai;
using PRism.Web.Ai;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public sealed class AiUsageEndpointTests
{
    /// <summary>Minimal hand-rolled TimeProvider stub returning a fixed "now". Mirrors the established
    /// pattern in CachedLlmAvailabilityProbeTests (Microsoft.Extensions.Time.Testing is not referenced
    /// in this project). Lets the endpoint's window-filtering be exercised at a deterministic instant.</summary>
    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    [Fact]
    public async Task Get_ai_usage_returns_200_empty_report_when_no_usage_recorded()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("window").GetString().Should().Be("7d"); // default
        body.GetProperty("totals").GetProperty("totalTokens").GetInt64().Should().Be(0);
        body.GetProperty("byFeature").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Get_ai_usage_echoes_validated_window_and_defaults_invalid()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        (await (await client.GetAsync(new Uri("/api/ai/usage?window=24h", UriKind.Relative)))
            .Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("window").GetString().Should().Be("24h");

        (await (await client.GetAsync(new Uri("/api/ai/usage?window=bogus", UriKind.Relative)))
            .Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("window").GetString().Should().Be("7d"); // invalid → default
    }

    [Fact]
    public async Task Get_ai_usage_is_not_gated_on_ai_mode_off()
    {
        using var factory = new PRismWebApplicationFactory();
        factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK); // 200, NOT 204 — past usage shows even when AI off
    }

    [Fact]
    public async Task Get_ai_usage_requires_session_auth()
    {
        using var factory = new PRismWebApplicationFactory();
        // No session token → exercises the global SessionTokenMiddleware. Use the factory's dedicated
        // unauthenticated-client helper (the established pattern; plain CreateClient injects a token).
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    /// <summary>Pins the full camelCase wire surface of GET /api/ai/usage over a populated report.
    /// Seeds the in-memory store with two interactions — one Ok provider call (with cost + input tokens)
    /// and one CacheHit — then requests <c>window=all</c> so the seeded bucket is always in-window.
    /// Asserts: 200, all top-level fields camelCased, populated numeric values, and the absence of any
    /// PascalCase key leak. Phase C frontend will mirror these exact field names.</summary>
    [Fact]
    public async Task Get_ai_usage_returns_full_camelCase_wire_surface_over_populated_report()
    {
        using var factory = new PRismWebApplicationFactory();

        // Seed the store BEFORE creating the client. The store is a singleton, so the handler's
        // SnapshotBuckets() call will see these entries. Mirror the Entry helper pattern from
        // AiUsageRollupStoreTests: timestamp, component, model, prRef, headSha, outcome, egressed,
        // latencyMs, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, cost.
        var store = factory.Services.GetRequiredService<AiUsageRollupStore>();

        var ts = new DateTimeOffset(2026, 1, 15, 10, 0, 0, TimeSpan.Zero);

        // Ok provider call: 100 input + 50 output + 200 cacheRead + 20 cacheCreation tokens, $0.05 cost
        store.Fold(new AiInteractionLogReader.LogEntry(ts,
            new AiInteractionRecord(
                Component: "summary",
                ProviderId: "claude-code",
                Model: "claude-opus-4",
                PrRef: "octo/repo#1",
                HeadSha: null,
                Outcome: AiInteractionOutcome.Ok,
                Egressed: true,
                InputTokens: 100,
                OutputTokens: 50,
                CacheReadInputTokens: 200,
                CacheCreationInputTokens: 20,
                EstimatedCostUsd: 0.05m)));

        // CacheHit: no tokens, no cost, increments CacheHits
        store.Fold(new AiInteractionLogReader.LogEntry(ts,
            new AiInteractionRecord(
                Component: "summary",
                ProviderId: "claude-code",
                Model: "claude-opus-4",
                PrRef: "octo/repo#1",
                HeadSha: null,
                Outcome: AiInteractionOutcome.CacheHit,
                Egressed: false)));

        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/usage?window=all", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var raw = await resp.Content.ReadAsStringAsync();
        var body = JsonDocument.Parse(raw).RootElement;

        // --- top-level fields (camelCase keys) ---
        body.TryGetProperty("window", out _).Should().BeTrue("window must be present");
        body.TryGetProperty("generatedAt", out _).Should().BeTrue("generatedAt must be present");
        body.TryGetProperty("totals", out var totals).Should().BeTrue("totals must be present");
        body.TryGetProperty("byFeature", out var byFeature).Should().BeTrue("byFeature must be present");
        body.TryGetProperty("byPr", out var byPr).Should().BeTrue("byPr must be present");
        body.TryGetProperty("totalPrCount", out _).Should().BeTrue("totalPrCount must be present");
        body.TryGetProperty("cache", out var cache).Should().BeTrue("cache must be present");
        body.TryGetProperty("trend", out var trend).Should().BeTrue("trend must be present");

        body.GetProperty("window").GetString().Should().Be("all");

        // --- totals sub-fields ---
        totals.TryGetProperty("inputTokens", out _).Should().BeTrue("totals.inputTokens must be present");
        totals.TryGetProperty("outputTokens", out _).Should().BeTrue("totals.outputTokens must be present");
        totals.TryGetProperty("cacheReadInputTokens", out _).Should().BeTrue("totals.cacheReadInputTokens must be present");
        totals.TryGetProperty("cacheCreationInputTokens", out _).Should().BeTrue("totals.cacheCreationInputTokens must be present");
        totals.TryGetProperty("totalTokens", out _).Should().BeTrue("totals.totalTokens must be present");
        totals.TryGetProperty("estimatedCostUsd", out _).Should().BeTrue("totals.estimatedCostUsd must be present");
        totals.TryGetProperty("providerCalls", out _).Should().BeTrue("totals.providerCalls must be present");
        totals.TryGetProperty("cacheHits", out _).Should().BeTrue("totals.cacheHits must be present");

        // populated numeric assertions: 100 input + 50 output + 200 cacheRead + 20 cacheCreation = 370 total
        totals.GetProperty("inputTokens").GetInt64().Should().Be(100);
        totals.GetProperty("outputTokens").GetInt64().Should().Be(50);
        totals.GetProperty("cacheReadInputTokens").GetInt64().Should().Be(200);
        totals.GetProperty("cacheCreationInputTokens").GetInt64().Should().Be(20);
        totals.GetProperty("totalTokens").GetInt64().Should().Be(370);
        totals.GetProperty("estimatedCostUsd").GetDecimal().Should().Be(0.05m);
        totals.GetProperty("providerCalls").GetInt32().Should().Be(1); // only the Ok outcome
        totals.GetProperty("cacheHits").GetInt32().Should().Be(1);     // the CacheHit outcome

        // --- byFeature[0] sub-fields ---
        byFeature.GetArrayLength().Should().BeGreaterThan(0, "seeded a 'summary' feature entry");
        var featureRow = byFeature[0];
        featureRow.TryGetProperty("component", out _).Should().BeTrue("byFeature[0].component must be present");
        featureRow.TryGetProperty("displayName", out _).Should().BeTrue("byFeature[0].displayName must be present");
        featureRow.TryGetProperty("totalTokens", out _).Should().BeTrue("byFeature[0].totalTokens must be present");
        featureRow.TryGetProperty("estimatedCostUsd", out _).Should().BeTrue("byFeature[0].estimatedCostUsd must be present");
        featureRow.TryGetProperty("providerCalls", out _).Should().BeTrue("byFeature[0].providerCalls must be present");
        featureRow.GetProperty("component").GetString().Should().Be("summary");
        featureRow.GetProperty("displayName").GetString().Should().Be("PR Summary");
        featureRow.GetProperty("totalTokens").GetInt64().Should().Be(370);
        featureRow.GetProperty("estimatedCostUsd").GetDecimal().Should().Be(0.05m);

        // --- byPr[0] sub-fields ---
        byPr.GetArrayLength().Should().BeGreaterThan(0, "seeded a byPr entry for octo/repo#1");
        var prRow = byPr[0];
        prRow.TryGetProperty("prRef", out _).Should().BeTrue("byPr[0].prRef must be present");
        prRow.TryGetProperty("displayLabel", out _).Should().BeTrue("byPr[0].displayLabel must be present");
        prRow.TryGetProperty("totalTokens", out _).Should().BeTrue("byPr[0].totalTokens must be present");
        prRow.TryGetProperty("estimatedCostUsd", out _).Should().BeTrue("byPr[0].estimatedCostUsd must be present");
        prRow.TryGetProperty("providerCalls", out _).Should().BeTrue("byPr[0].providerCalls must be present");
        prRow.GetProperty("prRef").GetString().Should().Be("octo/repo#1");
        prRow.GetProperty("totalTokens").GetInt64().Should().Be(370);

        // --- cache sub-fields ---
        cache.TryGetProperty("cacheHits", out _).Should().BeTrue("cache.cacheHits must be present");
        cache.TryGetProperty("providerCalls", out _).Should().BeTrue("cache.providerCalls must be present");
        cache.TryGetProperty("hitRate", out _).Should().BeTrue("cache.hitRate must be present");
        cache.GetProperty("cacheHits").GetInt32().Should().Be(1);
        cache.GetProperty("providerCalls").GetInt32().Should().Be(1);
        // hitRate = 1 / (1+1) = 0.5
        cache.GetProperty("hitRate").GetDouble().Should().BeApproximately(0.5, 1e-9);

        // --- trend (if non-empty) ---
        if (trend.GetArrayLength() > 0)
        {
            var bucket = trend[0];
            bucket.TryGetProperty("bucketStart", out _).Should().BeTrue("trend[0].bucketStart must be present");
            bucket.TryGetProperty("granularity", out _).Should().BeTrue("trend[0].granularity must be present");
            bucket.TryGetProperty("estimatedCostUsd", out _).Should().BeTrue("trend[0].estimatedCostUsd must be present");
            bucket.TryGetProperty("totalTokens", out _).Should().BeTrue("trend[0].totalTokens must be present");
        }

        // --- PascalCase leak guard: none of the DTO property names should appear in PascalCase ---
        raw.Should().NotContain("\"EstimatedCostUsd\"", "estimatedCostUsd must be camelCase");
        raw.Should().NotContain("\"ByPr\"", "byPr must be camelCase");
        raw.Should().NotContain("\"ByFeature\"", "byFeature must be camelCase");
        raw.Should().NotContain("\"TotalPrCount\"", "totalPrCount must be camelCase");
        raw.Should().NotContain("\"GeneratedAt\"", "generatedAt must be camelCase");
        raw.Should().NotContain("\"ProviderCalls\"", "providerCalls must be camelCase");
        raw.Should().NotContain("\"CacheHits\"", "cacheHits must be camelCase");
        raw.Should().NotContain("\"TotalTokens\"", "totalTokens must be camelCase");
        raw.Should().NotContain("\"BucketStart\"", "bucketStart must be camelCase");
        raw.Should().NotContain("\"DisplayLabel\"", "displayLabel must be camelCase");
        raw.Should().NotContain("\"PrRef\"", "prRef must be camelCase");
        raw.Should().NotContain("\"DisplayName\"", "displayName must be camelCase");
        raw.Should().NotContain("\"HitRate\"", "hitRate must be camelCase");
    }

    /// <summary>The endpoint must resolve "now" from the DI <see cref="TimeProvider"/> (not wall-clock),
    /// so that <c>window</c> filtering is deterministic and testable end-to-end. Seeds two buckets — one
    /// 2h before the fixed clock (inside the 24h window) and one 50h before (outside) — and asserts the
    /// 24h totals reflect ONLY the in-window bucket. Under a wall-clock handler both buckets fall months
    /// outside 24h, so the in-window assertion is the failing condition that pins the clock injection.</summary>
    [Fact]
    public async Task Get_ai_usage_filters_window_using_injected_clock()
    {
        var now = new DateTimeOffset(2026, 1, 15, 12, 0, 0, TimeSpan.Zero);
        using var baseFactory = new PRismWebApplicationFactory();
        using var factory = baseFactory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<TimeProvider>();
            s.AddSingleton<TimeProvider>(new FixedTimeProvider(now));
        }));

        // Seed BEFORE creating the client; the store is a singleton resolved from the derived factory.
        var store = factory.Services.GetRequiredService<AiUsageRollupStore>();

        // In-window: 2h before `now`. 100 input + 50 output tokens, $0.05.
        store.Fold(new AiInteractionLogReader.LogEntry(now.AddHours(-2),
            new AiInteractionRecord(
                Component: "summary", ProviderId: "claude-code", Model: "claude-opus-4",
                PrRef: "octo/repo#1", HeadSha: null, Outcome: AiInteractionOutcome.Ok, Egressed: true,
                InputTokens: 100, OutputTokens: 50, EstimatedCostUsd: 0.05m)));

        // Out-of-window: 50h before `now` (> 24h). 999 input tokens, $9.99 — must NOT count.
        store.Fold(new AiInteractionLogReader.LogEntry(now.AddHours(-50),
            new AiInteractionRecord(
                Component: "summary", ProviderId: "claude-code", Model: "claude-opus-4",
                PrRef: "octo/repo#2", HeadSha: null, Outcome: AiInteractionOutcome.Ok, Egressed: true,
                InputTokens: 999, OutputTokens: 0, EstimatedCostUsd: 9.99m)));

        // WithWebHostBuilder yields a vanilla factory whose CreateClient does not auto-inject the session
        // token; mirror the AiEndpointsTests pattern and inject it manually.
        var token = factory.Services.GetRequiredService<SessionTokenProvider>().Current;
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-PRism-Session", token);
        client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin)) client.DefaultRequestHeaders.Add("Origin", origin);

        var resp = await client.GetAsync(new Uri("/api/ai/usage?window=24h", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var totals = body.GetProperty("totals");
        // Only the in-window bucket: 100 input + 50 output = 150; $0.05. The 50h-old bucket is excluded.
        totals.GetProperty("inputTokens").GetInt64().Should().Be(100);
        totals.GetProperty("totalTokens").GetInt64().Should().Be(150);
        totals.GetProperty("estimatedCostUsd").GetDecimal().Should().Be(0.05m);
    }
}
