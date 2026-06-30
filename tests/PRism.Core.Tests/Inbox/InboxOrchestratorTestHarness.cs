using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.State;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Inbox;

/// <summary>
/// Single canonical source of truth for InboxRefreshOrchestrator test construction.
/// Used by InboxRehydrateTests (Task 2) and extended by Tasks 3–4 (cache param, wait
/// helpers). In Task 2 this is PROVISIONAL: the ctor has no cache param yet.
/// </summary>
public static class InboxOrchestratorTestHarness
{
    // ── Public test doubles ──────────────────────────────────────────────────────

    /// <summary>
    /// Seedable section runner. Ignores the visible-section filter so tests can use
    /// arbitrary section names (e.g. "mine"). Matches the existing test-file pattern
    /// of <c>new FakeSectionQueryRunner(_ =&gt; AllSections(...))</c>.
    /// </summary>
    public sealed class FakeSectionQueryRunner : ISectionQueryRunner
    {
        private readonly Dictionary<string, List<RawPrInboxItem>> _seed =
            new(StringComparer.Ordinal);

        /// <summary>Adds a minimal open PR to <paramref name="section"/>.</summary>
        public void Seed(string section, int prNumber)
        {
            if (!_seed.TryGetValue(section, out var list))
                _seed[section] = list = [];
            list.Add(new RawPrInboxItem(
                new PrReference("harness", "repo", prNumber),
                $"PR #{prNumber}", "author", "harness/repo",
                DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
                0, 0, 0, $"sha{prNumber}", 1, 0));
        }

        /// <inheritdoc/>
        public Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
            IReadOnlySet<string> visibleSectionIds, CancellationToken ct)
        {
            // Intentionally ignores visibleSectionIds so tests using non-standard
            // section names (e.g. "mine") still get their seeded data back.
            return Task.FromResult<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>>(
                _seed.ToDictionary(
                    kv => kv.Key,
                    kv => (IReadOnlyList<RawPrInboxItem>)kv.Value.ToList(),
                    StringComparer.Ordinal));
        }

        /// <inheritdoc/>
        public Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(
            int windowDays, CancellationToken ct)
            => Task.FromResult<IReadOnlyList<RawPrInboxItem>>(Array.Empty<RawPrInboxItem>());
    }

    /// <summary>
    /// Recording event bus. Captures every published event; <see cref="Clear"/> resets
    /// between phases (matches the existing RecordingEventBus in OrchestratorTests).
    /// </summary>
    public sealed class FakeReviewEventBus : IReviewEventBus
    {
        public List<IReviewEvent> Published { get; } = new();

        public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
            => Published.Add(evt!);

        public IDisposable Subscribe<TEvent>(Action<TEvent> handler)
            where TEvent : IReviewEvent => new NoopSub();

        /// <summary>Resets the capture list between test phases.</summary>
        public void Clear() => Published.Clear();

        private sealed class NoopSub : IDisposable { public void Dispose() { } }
    }

    // ── Factory ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns a live orchestrator plus the two fakes tests assert against.
    /// <paramref name="loginProvider"/>, when non-null, overrides <paramref name="login"/>
    /// as the viewer-login source.
    /// <para>
    /// PROVISIONAL (Task 2): no <c>cache</c> parameter. Task 3 adds an optional
    /// <c>IIdentityKeyedFileCache&lt;InboxSnapshot&gt; cache = null</c> parameter and
    /// a <c>WaitForCacheWriteIdleAsync</c> / <c>RaiseEnrichmentReady</c> helper.
    /// </para>
    /// </summary>
    public static (InboxRefreshOrchestrator Orch, FakeSectionQueryRunner Sections, FakeReviewEventBus Events) Build(
        string login = "octocat",
        string host = "github.com",
        Func<string>? loginProvider = null)
    {
        var sections = new FakeSectionQueryRunner();
        var events = new FakeReviewEventBus();
        var orch = CreateOrchestrator(sections, events, login, host, loginProvider);
        return (orch, sections, events);
    }

    // ── Snapshot helpers ─────────────────────────────────────────────────────────

    /// <summary>
    /// A snapshot containing one PR (<paramref name="prNumber"/>) in
    /// <paramref name="section"/>; seeds rehydrate/no-op tests (tests 9 and 10).
    /// </summary>
    public static InboxSnapshot SnapshotWith(string section, int prNumber)
    {
        var item = new PrInboxItem(
            Reference: new PrReference("harness", "repo", prNumber),
            Title: $"PR #{prNumber}",
            Author: "author",
            Repo: "harness/repo",
            UpdatedAt: DateTimeOffset.UtcNow,
            PushedAt: DateTimeOffset.UtcNow,
            CommitCount: 0,
            ChangedFiles: 0,
            CommentCount: 0,
            Additions: 0,
            Deletions: 0,
            HeadSha: $"sha{prNumber}",
            Ci: CiStatus.None,
            LastViewedHeadSha: null,
            LastSeenCommentId: null);
        return new InboxSnapshot(
            new Dictionary<string, IReadOnlyList<PrInboxItem>> { [section] = [item] },
            new Dictionary<string, InboxItemEnrichment>(),
            DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// The snapshot a live RefreshAsync WOULD produce from <paramref name="sections"/> —
    /// built by running a throwaway orchestrator's RefreshAsync over the same seed and
    /// returning its <c>Current</c>. Used so a rehydrate-then-refresh test yields
    /// <c>diff.Changed == false</c> (force-notify path, tests 11 and 14).
    /// </summary>
    public static async Task<InboxSnapshot> BuildEquivalentSnapshotAsync(FakeSectionQueryRunner sections)
    {
        using var orch = CreateOrchestrator(sections, new FakeReviewEventBus(), "octocat", "github.com", null);
        await orch.RefreshAsync(CancellationToken.None).ConfigureAwait(false);
        return orch.Current!;
    }

    /// <summary>
    /// An <see cref="IConfigStore"/> whose <c>Github.Accounts[0].Login == login</c>
    /// (or an empty Accounts list when <paramref name="login"/> is null) and
    /// <c>Github.Host == host</c>. Drives the rehydrator's fail-closed config-identity
    /// backstop (Task 4).
    /// </summary>
    public static IConfigStore ConfigWith(string? login, string host)
    {
        var accounts = login is null
            ? Array.Empty<GithubAccountConfig>()
            : new[] { new GithubAccountConfig(AccountKeys.Default, host, login, null) };
        var config = AppConfig.Default with { Github = new GithubConfig(accounts) };
        return new HarnessConfigStore(config);
    }

    // ── Private infrastructure ───────────────────────────────────────────────────

    private static InboxRefreshOrchestrator CreateOrchestrator(
        FakeSectionQueryRunner sections,
        FakeReviewEventBus events,
        string login,
        string host,
        Func<string>? loginProvider)
    {
        _ = host; // host is used by ConfigWith (Task 4); unused in Task 2 Build path
        Func<string> viewerLogin = loginProvider ?? (() => login);
        return new InboxRefreshOrchestrator(
            new HarnessConfigStore(AppConfig.Default),
            sections,
            new IdentityBatchReader(),
            new NullCiDetector(),
            new InboxDeduplicator(),
            new NullAiSeamSelector(),
            events,
            new InMemoryAppStateStore(),
            viewerLogin);
    }

    // Minimal IConfigStore implementation for the harness.
    private sealed class HarnessConfigStore : IConfigStore
    {
        private readonly AppConfig _config;
        public HarnessConfigStore(AppConfig config) => _config = config;
        public AppConfig Current => _config;
        public string ConfigPath => "/harness/config.json";
        public Exception? LastLoadError => null;
        public event EventHandler<ConfigChangedEventArgs>? Changed;
        public void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(_config));
        public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
        public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct)
            => Task.CompletedTask;
        public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct)
            => Task.CompletedTask;
        public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct)
            => Task.CompletedTask;
    }

    // Mirrors IdentityBatchReader in InboxRefreshOrchestratorTests.cs: echoes each item's
    // hydration fields and marks every PR awaiting-author by design (ViewerLastReviewSha != HeadSha).
    private sealed class IdentityBatchReader : IPrBatchReader
    {
        public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
            IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
            => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
                items.ToDictionary(i => i.Reference, i => new BatchPrData(
                    i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                    i.PushedAt, i.MergedAt, i.ClosedAt,
                    ViewerLastReviewSha: i.HeadSha + "-prev")));
    }

    // Returns CiStatus.None for every item, Complete=true.
    private sealed class NullCiDetector : ICiFailingDetector
    {
        public Task<CiDetectResult> DetectAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
            => Task.FromResult(new CiDetectResult(
                items.Select(i => (i, CiStatus.None)).ToList(),
                Complete: true));
    }

    // Routes every Resolve<T>() to a NoopInboxItemEnricher (no AI enrichment in harness tests).
    private sealed class NullAiSeamSelector : IAiSeamSelector
    {
        private static readonly IInboxItemEnricher _enricher = new NoopInboxItemEnricher();
        public T Resolve<T>() where T : class => (_enricher as T)!;
    }
}
