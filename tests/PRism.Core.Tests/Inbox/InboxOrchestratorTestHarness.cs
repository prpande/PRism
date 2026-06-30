using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.State;
using PRism.Core.Storage;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Inbox;

/// <summary>
/// Single canonical source of truth for InboxRefreshOrchestrator test construction.
/// Used by InboxRehydrateTests (Task 2) and InboxCacheWriteTests (Task 3).
/// </summary>
public static class InboxOrchestratorTestHarness
{
    // ── Public test doubles ──────────────────────────────────────────────────────

    /// <summary>
    /// Seedable section runner. Ignores the visible-section filter so tests can use
    /// arbitrary section names (e.g. "mine"). PRs are seeded as "octocat/hello#N" so
    /// Task 3's enrichment-ready assertions (which use that PrId) resolve against the
    /// live snapshot without requiring a separate seed step.
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
                new PrReference("octocat", "hello", prNumber),
                $"PR #{prNumber}", "author", "octocat/hello",
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
    /// between phases. Subscribe stores handlers so orchestrator subscriptions (e.g.
    /// OnInboxEnrichmentsReady) fire when Publish is called — required for trigger (b)
    /// in Task 3's cache write path.
    /// </summary>
    public sealed class FakeReviewEventBus : IReviewEventBus
    {
        public List<IReviewEvent> Published { get; } = new();
        private readonly List<(Type EventType, Action<IReviewEvent> Handler)> _subs = new();

        public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
        {
            Published.Add(evt!);
            foreach (var (type, handler) in _subs)
                if (type.IsInstanceOfType(evt)) handler(evt!);
        }

        public IDisposable Subscribe<TEvent>(Action<TEvent> handler)
            where TEvent : IReviewEvent
        {
            Action<IReviewEvent> wrapped = e => handler((TEvent)e);
            _subs.Add((typeof(TEvent), wrapped));
            return new NoopSub();
        }

        /// <summary>Resets the capture list between test phases.</summary>
        public void Clear() => Published.Clear();

        private sealed class NoopSub : IDisposable { public void Dispose() { } }
    }

    // ── Factory ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns a live orchestrator plus the two fakes tests assert against.
    /// <paramref name="cache"/> defaults to a fresh <see cref="RecordingIdentityCache{T}"/>.
    /// <paramref name="loginProvider"/>, when non-null, overrides <paramref name="login"/>
    /// as the viewer-login source. All parameters are optional; call sites use named args so
    /// this signature is backward-compatible with Task 2's <c>Build()</c> calls.
    /// </summary>
    public static (InboxRefreshOrchestrator Orch, FakeSectionQueryRunner Sections, FakeReviewEventBus Events) Build(
        IIdentityKeyedFileCache<InboxSnapshot>? cache = null,
        string login = "octocat",
        string host = "github.com",
        Func<string>? loginProvider = null)
    {
        var sections = new FakeSectionQueryRunner();
        var events = new FakeReviewEventBus();
        var orch = CreateOrchestrator(sections, events, cache, login, host, loginProvider);
        return (orch, sections, events);
    }

    // ── Wait / raise helpers (Task 3) ───────────────────────────────────────────

    /// <summary>
    /// Deterministic write-drain await: polls until both the in-flight drain loop is complete
    /// AND no new write is queued. Never uses a fixed Thread.Sleep (poll-condition-not-fixed-delay
    /// CI discipline).
    /// </summary>
    public static async Task WaitForCacheWriteIdleAsync(InboxRefreshOrchestrator orch)
    {
        while (true)
        {
            await orch.CacheWriteIdleAsync().ConfigureAwait(false);
            if (orch.IsCacheWriterIdle) return;
            // A new write was enqueued while we were awaiting the previous loop; spin once
            // more so the new loop's Task is captured and awaited in the next iteration.
            await Task.Yield();
        }
    }

    /// <summary>
    /// Raises the enrichment-ready event that the orchestrator subscribes to (drives
    /// OnInboxEnrichmentsReady), stamping <paramref name="prId"/> with <paramref name="chip"/>.
    /// The ContentToken is computed from the title format that <see cref="FakeSectionQueryRunner.Seed"/>
    /// uses (<c>$"PR #{num}"</c>, null description) so the orchestrator's token guard accepts it.
    /// </summary>
#pragma warning disable CA1030 // "Raise" prefix is a test-helper convention, not an event
    public static void RaiseEnrichmentReady(FakeReviewEventBus events, string prId, string chip)
    {
        // Parse the PR number from prId (e.g. "octocat/hello#1" → 1) to recompute the title
        // that FakeSectionQueryRunner.Seed uses: $"PR #{prNumber}". Description is always null.
        var num = int.Parse(prId.Split('#')[1], System.Globalization.CultureInfo.InvariantCulture);
        var token = InboxEnrichmentContent.Token($"PR #{num}", null);
        events.Publish(new InboxEnrichmentsReady(new[]
        {
            new InboxEnrichmentResult(prId, chip, token)
        }));
    }
#pragma warning restore CA1030

    // ── Snapshot helpers ─────────────────────────────────────────────────────────

    /// <summary>
    /// A snapshot containing one PR (<paramref name="prNumber"/>) in
    /// <paramref name="section"/>; seeds rehydrate/no-op tests (tests 9 and 10).
    /// Uses "harness/repo" owner/repo (distinct from Seed's "octocat/hello") so
    /// a rehydrated snapshot is distinguishable from a live-built one.
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
        using var orch = CreateOrchestrator(sections, new FakeReviewEventBus(), null, "octocat", "github.com", null);
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
        IIdentityKeyedFileCache<InboxSnapshot>? cache,
        string login,
        string host,
        Func<string>? loginProvider)
    {
        Func<string> viewerLogin = loginProvider ?? (() => login);
        // Use ConfigWith so _config.Current.Github.Host matches the provided host parameter,
        // which is used when stamping the CacheIdentity in trigger (a). Without this, the
        // orchestrator would use AppConfig.Default's "https://github.com" host, and the
        // identity assertion (test 12) would fail.
        return new InboxRefreshOrchestrator(
            ConfigWith(login, host),
            sections,
            new IdentityBatchReader(),
            new NullCiDetector(),
            new InboxDeduplicator(),
            new NullAiSeamSelector(),
            events,
            new InMemoryAppStateStore(),
            cache ?? new RecordingIdentityCache<InboxSnapshot>(),
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
