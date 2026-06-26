using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Web.Tests.TestHelpers;

// ── Test writer fake ──────────────────────────────────────────────────────────────────────────

/// <summary>
/// Controllable IPrLifecycleWriter. Records calls; returns NextResult on every action.
/// </summary>
internal sealed class TestPrLifecycleWriter : IPrLifecycleWriter
{
    public PrLifecycleResult NextResult { get; set; } = PrLifecycleResult.Ok;
    public List<string> Calls { get; } = new();

    private Task<PrLifecycleResult> Record(string verb)
    {
        Calls.Add(verb);
        return Task.FromResult(NextResult);
    }

    public Task<PrLifecycleResult> CloseAsync(PrReference r, CancellationToken ct) => Record("close");
    public Task<PrLifecycleResult> ReopenAsync(PrReference r, CancellationToken ct) => Record("reopen");
    public Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference r, CancellationToken ct) => Record("ready");
    public Task<PrLifecycleResult> ConvertToDraftAsync(PrReference r, CancellationToken ct) => Record("draft");
}

// ── Mutable cache ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// IActivePrCache whose IsSubscribed behaviour can be toggled at runtime. Used by
/// PrLifecycleEndpointsTestContext so SetSubscribed(false) lets the unsubscribed test drive the
/// subscribe gate to rejection without rebuilding the factory. Do NOT inherit
/// AllSubscribedActivePrCache here — that fake hardwires IsSubscribed = true and makes the
/// unsubscribed-returns-403 test permanently unable to go green.
/// </summary>
internal sealed class MutableActivePrCache : IActivePrCache
{
    private volatile bool _subscribed;

    public MutableActivePrCache(bool subscribed = true) => _subscribed = subscribed;

    public void SetSubscribed(bool value) => _subscribed = value;

    public bool IsSubscribed(PrReference prRef) => _subscribed;
    public ActivePrSnapshot? GetCurrent(PrReference prRef) => null;
    public void Update(PrReference prRef, ActivePrSnapshot snapshot) { }
    public void Clear() { }
}

// ── Test context ──────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Per-test harness for the PrLifecycleEndpoints. Builds a PRismWebApplicationFactory-derived
/// server (DataDir / wwwroot stub / Test env / session token all set up) with three touchpoints
/// replaced by controllable doubles: IPrLifecycleWriter (TestPrLifecycleWriter),
/// IReviewEventBus (FakeReviewEventBus), IActivePrCache (MutableActivePrCache).
/// New one per test; dispose deletes the temp DataDir.
/// </summary>
internal sealed class PrLifecycleEndpointsTestContext : IDisposable
{
    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;
    private readonly MutableActivePrCache _cache;

    public TestPrLifecycleWriter Writer { get; } = new();
    public FakeReviewEventBus Bus { get; } = new();

    private PrLifecycleEndpointsTestContext()
    {
        _cache = new MutableActivePrCache(subscribed: true);
        _base = new PRismWebApplicationFactory();
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IPrLifecycleWriter>();
            s.AddSingleton<IPrLifecycleWriter>(Writer);
            s.RemoveAll<IReviewEventBus>();
            s.AddSingleton<IReviewEventBus>(Bus);
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(_cache);
        }));
        // Force server (and DataDir/state.json) creation.
        _ = _derived.Services;
    }

    public static PrLifecycleEndpointsTestContext Create() => new();

    // Default tabId = "tab-test" so a plain CreateClient() has a valid X-PRism-Tab-Id.
    // Pass tabId: null to genuinely omit the header (the missing-tab-id test path).
    public HttpClient CreateClient(string? tabId = "tab-test") =>
        _derived.CreateAuthenticatedClient(tabId);

    /// <summary>Toggles the subscribe gate. Default is subscribed (true); the unsubscribed test
    /// calls SetSubscribed(false) BEFORE building the client so the gate rejects.</summary>
    public void SetSubscribed(bool subscribed) => _cache.SetSubscribed(subscribed);

    private IAppStateStore StateStore =>
        _derived.Services.GetRequiredService<IAppStateStore>();

    public async Task SeedSessionAsync(string owner, string repo, int number, ReviewSessionState session)
    {
        var key = $"{owner}/{repo}/{number}";
        await StateStore.UpdateAsync(state =>
        {
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [key] = session };
            return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
        }, CancellationToken.None).ConfigureAwait(false);
    }

    /// <summary>
    /// A minimal valid session carrying a tab-test stamp. Mirrors SubmitEndpointsTestContext.ValidSession —
    /// the lifecycle endpoint does not inspect session state directly, but the method is provided so
    /// tests follow the same seeding pattern as other endpoint test classes.
    /// </summary>
    public static ReviewSessionState ValidSession() => new(
        TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("head1", DateTime.UtcNow.AddMinutes(-1)) },
        LastSeenCommentId: null,
        PendingReviewId: null,
        PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: Array.Empty<DraftComment>(),
        DraftReplies: Array.Empty<DraftReply>(),
        DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    public void Dispose()
    {
        _derived.Dispose();
        _base.Dispose();
    }
}
