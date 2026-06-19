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
using PRism.Core.PrDetail;
using PRism.Web.Ai;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// No-op ITokenUsageTracker (non-fatal, spec §9). Shared by gate + regenerate tests.
internal sealed class NullTokenTracker : ITokenUsageTracker
{
    public Task RecordAsync(TokenUsageRecord record, CancellationToken ct) => Task.CompletedTask;
}

// No-op AI audit sink. Shared by gate + regenerate tests.
internal sealed class NullAiAuditLog : IAiInteractionLog
{
    public void Record(AiInteractionRecord record) { }
}

// Permissive IActivePrCache for the stub summarizer: null snapshot → R7 store always proceeds.
// Gate/regenerate tests assert HTTP status, not caching.
internal sealed class NullInnerActivePrCache : IActivePrCache
{
    public bool IsSubscribed(PrReference prRef) => true;
    public ActivePrSnapshot? GetCurrent(PrReference prRef) => null;
    public void Update(PrReference prRef, ActivePrSnapshot snapshot) { }
    public void Clear() { }
}

// Minimal IConfigStore for the stub summarizer's #525 hot-read cap. Gate/regenerate tests assert
// HTTP status, not the cap value, so AppConfig.Default (summaryMaxChars=1000) is sufficient.
internal sealed class NullConfigStore : IConfigStore
{
    public AppConfig Current => AppConfig.Default;
    public string ConfigPath => "/fake/config.json";
    public Exception? LastLoadError => null;
#pragma warning disable CS0067 // test double — the summarizer reads Current fresh, never subscribes
    public event EventHandler<ConfigChangedEventArgs>? Changed;
#pragma warning restore CS0067
    public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => Task.CompletedTask;
    public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => Task.CompletedTask;
    public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct) => Task.CompletedTask;
}

/// <summary>
/// Per-test harness. Wires a stubbed ClaudeCodeSummarizer (no PrDetailLoader dependency)
/// and a ConfigurableActivePrCache. Shared by AiSummaryGateTests and AiSummaryRegenerateTests.
/// </summary>
internal sealed class AiSummaryTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;

    public AiModeState ModeState => _derived.Services.GetRequiredService<AiModeState>();
    public AiConsentState ConsentState => _derived.Services.GetRequiredService<AiConsentState>();

    public AiSummaryTestContext(ILlmProvider provider, bool subscribeAll)
    {
        var stubSummarizer = new ClaudeCodeSummarizer(
            provider, new NullTokenTracker(),
            (_, _) => Task.FromResult(("+ added", "Title", "Desc", "base1", "sha1")),
            NullLogger<ClaudeCodeSummarizer>.Instance, new NullAiAuditLog(),
            new PRism.Core.Events.ReviewEventBus(), // fresh bus — see note
            new NullInnerActivePrCache(),
            new NullConfigStore());

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
