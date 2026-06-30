using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.State;
using PRism.Core.Storage;
using PRism.Core.Tests.PrDetail;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxRefreshOrchestratorTests
{
    // ── Helpers ────────────────────────────────────────────────────────────────

    private static PrReference Ref(int n, string owner = "acme", string repo = "api")
        => new(owner, repo, n);

    private static RawPrInboxItem RawPr(int n, string headSha = "sha", string owner = "acme", string repo = "api")
        => new(Ref(n, owner, repo), $"PR #{n}", "author", $"{owner}/{repo}",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, headSha, 1, 0);

    private static RawPrInboxItem RawClosed(int n, DateTimeOffset? merged, DateTimeOffset? closed, string headSha = "")
        => new(Ref(n), $"PR #{n}", "author", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, headSha, 1, 0,
            MergedAt: merged, ClosedAt: closed);

    private static RawPrInboxItem RawClosedRepo(int n, string repo, DateTimeOffset closed)
    {
        var slash = repo.IndexOf('/', StringComparison.Ordinal);
        var owner = repo[..slash];
        var name = repo[(slash + 1)..];
        // Closed-but-not-merged fixture: only ClosedAt is set so the helper
        // matches its name and doesn't conflate merged vs closed. The recency
        // sort uses MergedAt ?? ClosedAt ?? UpdatedAt, so ClosedAt drives order.
        return new(Ref(n, owner, name), $"PR #{n}", "author", repo,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "", 1, 0,
            MergedAt: null, ClosedAt: closed);
    }

    // A bus that captures every published event for assertion
    private sealed class RecordingEventBus : IReviewEventBus
    {
        public List<IReviewEvent> Published { get; } = new();
        public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent => Published.Add(evt!);
        public IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent
            => new Sub();
        private sealed class Sub : IDisposable { public void Dispose() { } }
    }

    // Minimal AI seam selector that delegates to a pre-chosen enricher
    private sealed class FakeAiSeamSelector : IAiSeamSelector
    {
        private readonly IInboxItemEnricher _enricher;
        public FakeAiSeamSelector(IInboxItemEnricher enricher) { _enricher = enricher; }
        public T Resolve<T>() where T : class => (_enricher as T)!;
    }

    // Section runner: returns a fixed dictionary of sections → items, plus a configurable
    // closed-history list and a callback that fires when QueryClosedHistoryAsync is invoked.
    private sealed class FakeSectionQueryRunner : ISectionQueryRunner
    {
        private readonly Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> _factory;
        private readonly IReadOnlyList<RawPrInboxItem> _closed;
        private readonly Action? _onClosedQueried;
        public FakeSectionQueryRunner(
            Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> factory,
            IReadOnlyList<RawPrInboxItem>? closed = null,
            Action? onClosedQueried = null)
            { _factory = factory; _closed = closed ?? Array.Empty<RawPrInboxItem>(); _onClosedQueried = onClosedQueried; }
        public Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
            IReadOnlySet<string> v, CancellationToken ct) => Task.FromResult(_factory(v));
        public int? LastClosedWindowDays { get; private set; }
        public Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(int windowDays, CancellationToken ct)
        {
            LastClosedWindowDays = windowDays;
            _onClosedQueried?.Invoke();
            return Task.FromResult(_closed);
        }
    }

    // Batch reader: echoes each item's hydration fields and marks every PR awaiting-author by
    // default (ViewerLastReviewSha != HeadSha), matching the old Identity+Passthrough pair.
    private sealed class IdentityBatchReader : IPrBatchReader
    {
        public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
            IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
            => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
                items.ToDictionary(i => i.Reference, i => new BatchPrData(
                    i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                    i.PushedAt, i.MergedAt, i.ClosedAt,
                    ViewerLastReviewSha: i.HeadSha + "-prev")));   // != HeadSha → awaiting-author kept
    }

    // Batch reader that simulates dropped hydration (e.g. GitHub 404 / PAT-invisible repo):
    // the given PR numbers are absent from the result dict, so those refs fall back to the raw
    // Search item (empty headSha) and are dropped by the orchestrator's HeadSha filter.
    private sealed class DropBatchReader : IPrBatchReader
    {
        private readonly HashSet<int> _drop;
        public DropBatchReader(params int[] drop) => _drop = drop.ToHashSet();
        public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
            IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
            => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
                items.Where(i => !_drop.Contains(i.Reference.Number))
                     .ToDictionary(i => i.Reference, i => new BatchPrData(
                         i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                         i.PushedAt, i.MergedAt, i.ClosedAt, i.HeadSha + "-prev")));
    }

    // CI detector: returns all items with a fixed status + a configurable Complete flag,
    // or throws a supplied exception to exercise fault-isolation.
    private sealed class FakeCiDetector : ICiFailingDetector
    {
        private readonly CiStatus _status;
        private readonly bool _complete;
        private readonly Exception? _throw;
        public IReadOnlyList<RawPrInboxItem>? LastInput { get; private set; }
        public bool LastForceReprobe { get; private set; }
        public FakeCiDetector(CiStatus status = CiStatus.None, bool complete = true, Exception? toThrow = null)
            { _status = status; _complete = complete; _throw = toThrow; }
        public Task<CiDetectResult> DetectAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
        {
            LastInput = items;
            LastForceReprobe = forceReprobe;
            if (_throw is not null) throw _throw;
            return Task.FromResult(new CiDetectResult(
                items.Select(i => (i, _status)).ToList(), _complete));
        }
    }

    private static AppConfig DefaultConfig() => AppConfig.Default;

    private static AppConfig ConfigWithSections(
        bool reviewRequested = true,
        bool awaitingAuthor = true,
        bool authoredByMe = true,
        bool mentioned = true,
        bool recentlyClosed = false,
        int recentlyClosedWindowDays = 14)
        => AppConfig.Default with
        {
            Inbox = new InboxConfig(
                Deduplicate: false,
                Sections: new InboxSectionsConfig(
                    reviewRequested, awaitingAuthor, authoredByMe, mentioned, recentlyClosed),
                ShowHiddenScopeFooter: true,
                RecentlyClosedWindowDays: recentlyClosedWindowDays)
        };

    // Real in-project doubles (house rule: test real classes against real
    // collaborators; mock only external boundaries). FakeConfigStore exposes a
    // settable Current; InMemoryAppStateStore serves LoadAsync from its seeded state.
    private static FakeConfigStore ConfigStoreFake(AppConfig? config = null)
        => new() { Current = config ?? DefaultConfig() };

    private static InMemoryAppStateStore StateStoreFake(AppState? state = null)
        => new(state ?? AppState.Default);

    /// <summary>
    /// Returns a dictionary with the given section IDs populated with <paramref name="prsPerSection"/> items each.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>> AllSections(
        int prsPerSection, string[] sectionIds, int prNumberOffset = 0)
    {
        var d = new Dictionary<string, IReadOnlyList<RawPrInboxItem>>();
        var n = prNumberOffset;
        foreach (var id in sectionIds)
        {
            d[id] = Enumerable.Range(n + 1, prsPerSection).Select(i => RawPr(i, "sha" + i)).ToList();
            n += prsPerSection;
        }
        return d;
    }

    private static InboxRefreshOrchestrator Build(
        IConfigStore? config = null,
        ISectionQueryRunner? sections = null,
        IPrBatchReader? batchReader = null,
        ICiFailingDetector? ciDetector = null,
        IInboxDeduplicator? dedupe = null,
        IAiSeamSelector? aiSelector = null,
        IReviewEventBus? events = null,
        IAppStateStore? stateStore = null,
        IIdentityKeyedFileCache<InboxSnapshot>? cache = null, // #619
        Func<string>? viewerLogin = null)
        => new(
            config ?? ConfigStoreFake(),
            sections ?? new FakeSectionQueryRunner(_ =>
                new Dictionary<string, IReadOnlyList<RawPrInboxItem>>()),
            batchReader ?? new IdentityBatchReader(),
            ciDetector ?? new FakeCiDetector(),
            dedupe ?? new InboxDeduplicator(),
            aiSelector ?? new FakeAiSeamSelector(new NoopInboxItemEnricher()),
            events ?? new RecordingEventBus(),
            stateStore ?? StateStoreFake(),
            cache ?? new RecordingIdentityCache<InboxSnapshot>(), // #619
            viewerLogin ?? (() => "testuser"));

    // Convenience overload that wraps a section factory into FakeSectionQueryRunner and
    // threads through a CI detector. Used by the CI-fan-out tests below.
    private static InboxRefreshOrchestrator BuildSut(
        Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> sections,
        ICiFailingDetector ciDetector,
        IConfigStore? config = null,
        IReviewEventBus? events = null)
        => Build(
            config: config ?? ConfigStoreFake(),
            sections: new FakeSectionQueryRunner(sections),
            ciDetector: ciDetector,
            events: events);

    // Open, non-draft PR (no terminal timestamps, IsDraft=false — default)
    private static RawPrInboxItem RawOpen(int n) => RawPr(n, "sha" + n);

    // Open, non-draft PR with explicit title and description (for content-token tests)
    private static RawPrInboxItem RawOpen(int n, string title, string desc, string owner = "octo", string repo = "repo")
        => new(Ref(n, owner, repo), title, "author", $"{owner}/{repo}",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha" + n, 1, 0,
            Description: desc);

    // Draft PR (open, but IsDraft=true)
    private static RawPrInboxItem RawDraft(int n) => RawPr(n, "sha" + n) with { IsDraft = true };

    // Capturing inbox-item enricher — records the list passed to EnrichAsync
    private sealed class CapturingEnricher : IInboxItemEnricher
    {
        public IReadOnlyList<PrInboxItem> LastInput { get; private set; } = Array.Empty<PrInboxItem>();
        public Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(IReadOnlyList<PrInboxItem> items, CancellationToken ct)
        {
            LastInput = items;
            return Task.FromResult<IReadOnlyList<InboxItemEnrichment>>(Array.Empty<InboxItemEnrichment>());
        }
    }

    // ── Tests ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task First_refresh_completes_TCS_and_publishes_event()
    {
        var bus = new RecordingEventBus();
        var sectionIds = new[] { "review-requested", "awaiting-author", "authored-by-me", "mentioned" };
        var sections = new FakeSectionQueryRunner(_ => AllSections(2, sectionIds));

        var configFake = ConfigStoreFake(ConfigWithSections());
        using var sut = Build(
            config: configFake,
            sections: sections,
            events: bus);

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current.Should().NotBeNull();

        var waited = await sut.WaitForFirstSnapshotAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None);
        waited.Should().BeTrue();

        bus.Published.Should().HaveCount(1);
        bus.Published[0].Should().BeOfType<InboxUpdated>();
    }

    [Fact]
    public async Task Identical_followup_refresh_publishes_nothing()
    {
        var bus = new RecordingEventBus();
        var sectionIds = new[] { "review-requested", "authored-by-me" };
        var sections = new FakeSectionQueryRunner(_ => AllSections(2, sectionIds));

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: true,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections, events: bus);

        await sut.RefreshAsync(CancellationToken.None);
        await sut.RefreshAsync(CancellationToken.None);

        // First refresh publishes; second identical refresh publishes nothing
        bus.Published.Should().HaveCount(1);
    }

    [Fact]
    public async Task HeadSha_change_publishes_event_with_correct_count()
    {
        var bus = new RecordingEventBus();
        var firstSections = new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1, "sha-v1"), RawPr(2, "sha-v2") }
        };
        var secondSections = new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1, "sha-v1-updated"), RawPr(2, "sha-v2") }
        };

        var call = 0;
        var sections = new FakeSectionQueryRunner(_ =>
            ++call == 1 ? firstSections : secondSections);

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections, events: bus);

        await sut.RefreshAsync(CancellationToken.None);
        await sut.RefreshAsync(CancellationToken.None);

        bus.Published.Should().HaveCount(2);
        var second = (InboxUpdated)bus.Published[1];
        second.NewOrUpdatedPrCount.Should().Be(1);
    }

    [Fact]
    public async Task Hidden_section_is_not_queried()
    {
        IReadOnlySet<string>? capturedVisible = null;
        var sections = new FakeSectionQueryRunner(visible =>
        {
            capturedVisible = visible;
            return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>();
        });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: true,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        capturedVisible.Should().NotBeNull();
        capturedVisible!.Should().NotContain("mentioned");
        capturedVisible.Should().NotContain("awaiting-author");
        capturedVisible.Should().Contain("review-requested");
        capturedVisible.Should().Contain("authored-by-me");
    }

    [Fact]
    public async Task AiPreview_off_returns_empty_enrichments()
    {
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1) }
        });

        using var sut = Build(
            sections: sections,
            aiSelector: new FakeAiSeamSelector(new NoopInboxItemEnricher()));

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current!.Enrichments.Should().BeEmpty();
    }

    [Fact]
    public async Task AiPreview_on_returns_per_pr_enrichments()
    {
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1), RawPr(2) }
        });

        using var sut = Build(
            sections: sections,
            aiSelector: new FakeAiSeamSelector(new PlaceholderInboxItemEnricher()));

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current!.Enrichments.Should().HaveCount(2);
    }

    [Fact]
    public async Task Empty_section_does_not_abort_refresh()
    {
        // One section returns empty — snapshot is still produced
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = Array.Empty<RawPrInboxItem>()
        });

        using var sut = Build(sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current.Should().NotBeNull();
        sut.Current!.Sections["review-requested"].Should().BeEmpty();
    }

    [Fact]
    public async Task WaitForFirstSnapshot_returns_false_on_timeout_before_refresh()
    {
        using var sut = Build();

        var result = await sut.WaitForFirstSnapshotAsync(
            TimeSpan.FromMilliseconds(10), CancellationToken.None);

        result.Should().BeFalse();
    }

    [Fact]
    public async Task WaitForFirstSnapshot_throws_when_token_already_canceled()
    {
        // #323 item 4b: WaitForFirstSnapshotAsync now races the first-snapshot task with
        // Task.WaitAsync(timeout, ct) (no leaked Task.Delay timer). WaitAsync throws on
        // cancellation rather than returning false — a canceled request token surfaces as
        // OperationCanceledException, which the ASP.NET host translates to a client-disconnect.
        // (The timeout path still returns false; see the test above.)
        using var sut = Build();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var act = async () => await sut.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task RefreshAsync_when_AuthoredByMe_disabled_omits_authored_by_me_section()
    {
        // Coverage for the simplified ResolveVisibleSections gating (ci-failing removed):
        // authored-by-me must be absent from the visible set AND the snapshot when the
        // user disables that section. Previously the CI fan-out force-added authored-by-me
        // to derive the ci-failing subset; now that ci-failing is gone, the gate is plain.
        IReadOnlySet<string>? capturedVisible = null;
        var sections = new FakeSectionQueryRunner(visible =>
        {
            capturedVisible = visible;
            return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { RawPr(1, "sha-1") },
            };
        });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        capturedVisible.Should().NotBeNull();
        capturedVisible!.Should().NotContain("authored-by-me");
        sut.Current.Should().NotBeNull();
        sut.Current!.Sections.Should().NotContainKey("authored-by-me");
        sut.Current.Sections.Should().NotContainKey("ci-failing");
    }

    [Fact]
    public async Task Ci_is_probed_for_all_live_sections_not_just_authored()
    {
        var detector = new FakeCiDetector(CiStatus.Failing);
        var sut = BuildSut(
            sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { RawPr(1) },
                ["authored-by-me"]   = new[] { RawPr(2) },
            },
            ciDetector: detector);

        await sut.RefreshAsync(CancellationToken.None);

        // detector saw BOTH refs (distinct), and the review-requested PR carries CI now.
        detector.LastInput!.Select(i => i.Reference.Number).Should().BeEquivalentTo(new[] { 1, 2 });
        sut.Current!.Sections["review-requested"][0].Ci.Should().Be(CiStatus.Failing);
        sut.Current.Sections.Should().NotContainKey("ci-failing");
    }

    [Fact]
    public async Task RefreshAsync_hardRefresh_forwards_forceReprobe_to_detector()
    {
        // #355 Lever 2 wiring: the manual-refresh path (hardRefresh: true) must thread
        // forceReprobe through to the CI detector; the background poll / cold-start
        // (default false) must keep the cheap cached path.
        var ci = new FakeCiDetector(CiStatus.Passing);
        var sut = BuildSut(
            sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["authored-by-me"] = new[] { RawPr(1) },
            },
            ciDetector: ci);

        await sut.RefreshAsync(CancellationToken.None);                       // default false
        ci.LastForceReprobe.Should().BeFalse("a normal poll/cold-start must use the cached path");

        await sut.RefreshAsync(CancellationToken.None, hardRefresh: true);    // manual refresh
        ci.LastForceReprobe.Should().BeTrue("a hard refresh must force the CI re-read");
    }

    [Fact]
    public async Task Ci_fan_out_dedupes_a_pr_shared_across_sections_to_a_single_probe_input()
    {
        // The SAME PR ref appears in two live sections. The orchestrator's CI fan-out
        // projects all live items distinct-by-ref before handing them to the detector,
        // so the detector must see that ref exactly once — never one input per section
        // appearance (which would waste Checks-API budget probing the same PR twice).
        var shared = RawPr(7);
        var detector = new FakeCiDetector(CiStatus.Failing);
        var sut = BuildSut(
            sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { shared },
                ["authored-by-me"]   = new[] { shared },
            },
            ciDetector: detector);

        await sut.RefreshAsync(CancellationToken.None);

        detector.LastInput!.Count.Should().Be(1, "a PR shared across sections is probed once, not per appearance");
        detector.LastInput!.Single().Reference.Number.Should().Be(7);
    }

    [Fact]
    public async Task Ci_rate_limit_publishes_snapshot_then_resurfaces_for_backoff()
    {
        var detector = new FakeCiDetector(toThrow: new RateLimitExceededException("429", TimeSpan.FromSeconds(30)));
        var sut = BuildSut(
            sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { RawPr(1) },
            },
            ciDetector: detector);

        var act = async () => await sut.RefreshAsync(CancellationToken.None);

        await act.Should().ThrowAsync<RateLimitExceededException>();   // re-surfaced for poller backoff
        sut.Current.Should().NotBeNull();                              // …but the snapshot still published
        sut.Current!.Sections["review-requested"].Should().ContainSingle();
        sut.Current.CiProbeComplete.Should().BeFalse();
    }

    [Fact]
    public async Task Ci_probe_incomplete_sets_flag_without_throwing()
    {
        var detector = new FakeCiDetector(CiStatus.None, complete: false);
        var sut = BuildSut(
            sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { RawPr(1) },
            },
            ciDetector: detector);

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current!.CiProbeComplete.Should().BeFalse();
    }

    [Fact]
    public async Task Section_removal_triggers_inbox_updated_event()
    {
        // Arrange: first refresh has "review-requested" + "mentioned"; second has only "mentioned".
        // ComputeDiff must detect the removal of "review-requested" and publish an event.
        var bus = new RecordingEventBus();
        var call = 0;
        var sections = new FakeSectionQueryRunner(_ =>
        {
            call++;
            if (call == 1)
                return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
                {
                    ["review-requested"] = new[] { RawPr(1) },
                    ["mentioned"]        = new[] { RawPr(2) },
                };
            return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["mentioned"] = new[] { RawPr(2) }, // "review-requested" removed
            };
        });

        using var sut = Build(sections: sections, events: bus);

        await sut.RefreshAsync(CancellationToken.None); // first: always changed
        await sut.RefreshAsync(CancellationToken.None); // second: one section gone

        bus.Published.Should().HaveCount(2, "removing a section is a change and must publish an event");
        var second = (InboxUpdated)bus.Published[1];
        second.ChangedSectionIds.Should().Contain("review-requested",
            "the removed section must appear in the changed-section list");
    }

    [Fact]
    public async Task RefreshAsync_when_only_PR_removals_publishes_InboxUpdated_with_nonzero_count()
    {
        // First refresh has 2 PRs in review-requested. Second refresh has 0 PRs in
        // review-requested (e.g. they were merged / closed). The previous behavior
        // was to publish InboxUpdated with NewOrUpdatedPrCount == 0, which caused
        // the frontend banner to render the misleading "0 new updates". Removed
        // PRs are real changes — they must contribute to the count.
        var bus = new RecordingEventBus();
        var call = 0;
        var sections = new FakeSectionQueryRunner(_ =>
        {
            call++;
            if (call == 1)
                return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
                {
                    ["review-requested"] = new[] { RawPr(1), RawPr(2) },
                };
            return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = Array.Empty<RawPrInboxItem>(),
            };
        });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections, events: bus);

        await sut.RefreshAsync(CancellationToken.None); // first
        await sut.RefreshAsync(CancellationToken.None); // second: both PRs gone

        bus.Published.Should().HaveCount(2);
        var second = (InboxUpdated)bus.Published[1];
        second.NewOrUpdatedPrCount.Should().Be(2,
            "the two removed PRs must be counted so the banner doesn't show '0 new updates'");
    }

    [Fact]
    public async Task RefreshAsync_when_section_removed_counts_its_PRs_into_NewOrUpdatedPrCount()
    {
        // First refresh has review-requested (2 PRs) and mentioned (1 PR). Second
        // refresh has only mentioned (1 PR, unchanged). The 2 PRs in the dropped
        // review-requested section must contribute to NewOrUpdatedPrCount.
        var bus = new RecordingEventBus();
        var call = 0;
        var sections = new FakeSectionQueryRunner(_ =>
        {
            call++;
            if (call == 1)
                return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
                {
                    ["review-requested"] = new[] { RawPr(1), RawPr(2) },
                    ["mentioned"]        = new[] { RawPr(3) },
                };
            return new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["mentioned"] = new[] { RawPr(3) },
            };
        });

        using var sut = Build(sections: sections, events: bus);

        await sut.RefreshAsync(CancellationToken.None);
        await sut.RefreshAsync(CancellationToken.None);

        bus.Published.Should().HaveCount(2);
        var second = (InboxUpdated)bus.Published[1];
        second.NewOrUpdatedPrCount.Should().Be(2,
            "PRs from a removed section must contribute to the count");
    }

    [Fact]
    public async Task PR_in_two_non_paired_sections_with_placeholder_enricher_does_not_throw()
    {
        // Regression: a PR that legitimately appears in two visible sections outside the
        // InboxDeduplicator's two configured pairs (review-requested↔mentioned,
        // ci-failing↔authored-by-me) used to crash RefreshAsync at the
        // `enrichments.ToDictionary(e => e.PrId)` step, because the placeholder enricher
        // emits one enrichment per input item and `allItems` carries the same PR twice.
        // The crash kept _firstSnapshotTcs from completing, so /api/inbox returned 503
        // forever and the frontend showed "Couldn't load inbox. Try again."
        var dual = RawPr(42);
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["authored-by-me"]  = new[] { dual },
            ["awaiting-author"] = new[] { dual },
        });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: false, awaitingAuthor: true, authoredByMe: true,
            mentioned: false));
        using var sut = Build(
            config: configFake,
            sections: sections,
            aiSelector: new FakeAiSeamSelector(new PlaceholderInboxItemEnricher()));

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current.Should().NotBeNull();
        sut.Current!.Enrichments.Should().ContainKey(dual.Reference.PrId);
        sut.Current.Enrichments.Should().HaveCount(1, "enrichment is per unique PR, not per section appearance");
    }

    [Fact]
    public async Task State_json_reads_propagate_to_inbox_items()
    {
        // Arrange: state.json has a session entry for PR #1 in acme/api
        // Slash form per S4 PR1 — matches PrReference.ToString() canonical form.
        var sessionKey = "acme/api/1";
        var sessionState = new ReviewSessionState(
            TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("abc", DateTime.UtcNow.AddMinutes(-1)) },
            LastSeenCommentId: "12345",
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
        var appState = AppState.Default.WithDefaultReviews(new PrSessionsState(new Dictionary<string, ReviewSessionState>
        {
            [sessionKey] = sessionState
        }));

        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1, "sha-head") }
        });

        var stateStoreFake = StateStoreFake(appState);
        using var sut = Build(sections: sections, stateStore: stateStoreFake);

        await sut.RefreshAsync(CancellationToken.None);

        var items = sut.Current!.Sections["review-requested"];
        var pr1 = items.Single(p => p.Reference.Number == 1);
        pr1.LastViewedHeadSha.Should().Be("abc");
        pr1.LastSeenCommentId.Should().Be(12345L);
    }

    // ── Recently-closed section ──────────────────────────────────────────────────

    [Fact]
    public async Task RecentlyClosed_Enabled_AppendsSection_SortedByCloseDesc()
    {
        var older = DateTimeOffset.Parse("2026-05-10T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var newer = DateTimeOffset.Parse("2026-05-20T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
            closed: new[] { RawClosed(1, older, older), RawClosed(2, newer, newer) });

        var configFake = ConfigStoreFake(ConfigWithSections(recentlyClosed: true));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
        sec.Select(i => i.Reference.Number).Should().Equal(2, 1); // newest first
        sec[0].MergedAt.Should().Be(newer);
    }

    [Fact]
    public async Task RecentlyClosed_KeepsMergedPrWithEmptyHeadSha()
    {
        var when = DateTimeOffset.Parse("2026-05-20T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
            closed: new[] { RawClosed(7, when, when, headSha: "") });

        var configFake = ConfigStoreFake(ConfigWithSections(recentlyClosed: true));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
        sec.Select(i => i.Reference.Number).Should().Contain(7);
    }

    [Fact]
    public async Task RecentlyClosed_UnenrichedRow_SynthesizesTerminalClosedAtFromUpdatedAt()
    {
        // The raw Search item carries null close timestamps (refined only in the
        // fan-out enrichment). Simulate a dropped enrichment so the row falls back
        // to raw — without the fallback fix it would render badge-less + unread.
        var updated = DateTimeOffset.Parse("2026-05-20T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var rawClosed = RawClosed(7, merged: null, closed: null) with { UpdatedAt = updated };
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
            closed: new[] { rawClosed });

        using var sut = Build(
            config: ConfigStoreFake(ConfigWithSections(recentlyClosed: true)),
            sections: sections,
            batchReader: new DropBatchReader(7)); // #7 batch drops → fallback to raw

        await sut.RefreshAsync(CancellationToken.None);

        var row = sut.Current!.Sections[InboxHistoryConstants.SectionId]
            .Single(i => i.Reference.Number == 7);
        // Fallback marks the row terminal (ClosedAt == UpdatedAt) so the FE treats
        // it as done + read rather than non-terminal + falsely-unread.
        row.ClosedAt.Should().Be(updated);
        row.MergedAt.Should().BeNull();
    }

    [Fact]
    public async Task RecentlyClosed_CapsAtMaxRepos_KeepingMostRecentlyClosedRepos()
    {
        var baseTime = DateTimeOffset.Parse("2026-05-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var repoCount = InboxHistoryConstants.MaxHistoryRepos + 5;
        var closed = Enumerable.Range(1, repoCount)
            .Select(i => RawClosedRepo(i, $"acme/repo{i:D2}", baseTime.AddMinutes(i)))
            .ToArray();
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(), closed: closed);
        using var sut = Build(config: ConfigStoreFake(ConfigWithSections(recentlyClosed: true)), sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
        var repos = sec.Select(i => i.Repo).Distinct().ToList();
        repos.Should().HaveCount(InboxHistoryConstants.MaxHistoryRepos);
        repos.Should().NotContain("acme/repo01");
        repos.First().Should().Be($"acme/repo{repoCount:D2}");
    }

    [Fact]
    public async Task RecentlyClosed_CapIsOnRepos_NotPrs_RetainsAllPrsOfKeptRepos()
    {
        var t = DateTimeOffset.Parse("2026-05-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var closed = new[]
        {
            RawClosedRepo(1, "acme/api", t.AddMinutes(50)),
            RawClosedRepo(2, "acme/api", t.AddMinutes(40)),
            RawClosedRepo(3, "acme/api", t.AddMinutes(30)),
            RawClosedRepo(4, "acme/web", t.AddMinutes(45)),
            RawClosedRepo(5, "acme/web", t.AddMinutes(35)),
        };
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(), closed: closed);
        using var sut = Build(config: ConfigStoreFake(ConfigWithSections(recentlyClosed: true)), sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
        sec.Should().HaveCount(5);
        sec.Select(i => i.Repo).Distinct().Should().Equal("acme/api", "acme/web");
    }

    [Fact]
    public async Task RecentlyClosed_TieOnNewestClose_IsDeterministic()
    {
        var t = DateTimeOffset.Parse("2026-05-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var closed = new[]
        {
            RawClosedRepo(10, "acme/aaa", t),
            RawClosedRepo(20, "acme/bbb", t),
        };
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(), closed: closed);
        using var sut = Build(config: ConfigStoreFake(ConfigWithSections(recentlyClosed: true)), sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
        sec.Select(i => i.Repo).Should().Equal("acme/bbb", "acme/aaa"); // PR #20 > #10 → bbb first
    }

    [Fact]
    public async Task RecentlyClosed_Disabled_NoSection_AndNoQuery()
    {
        var queried = false;
        var when = DateTimeOffset.Parse("2026-05-20T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
            closed: new[] { RawClosed(9, when, when) },
            onClosedQueried: () => queried = true);

        var configFake = ConfigStoreFake(ConfigWithSections(recentlyClosed: false));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current!.Sections.Should().NotContainKey(InboxHistoryConstants.SectionId);
        queried.Should().BeFalse("QueryClosedHistoryAsync must not be called when the section is disabled");
    }

    [Fact]
    public async Task RecentlyClosed_QueriesWithConfiguredWindow()
    {
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
            closed: Array.Empty<RawPrInboxItem>());
        var configFake = ConfigStoreFake(ConfigWithSections(recentlyClosed: true, recentlyClosedWindowDays: 30));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        sections.LastClosedWindowDays.Should().Be(30);
    }

    // Build overload for enrichments-ready tests: accepts an explicit bus and a section
    // seeded with the given open items in "review-requested".
    private static InboxRefreshOrchestrator BuildOrchestrator(
        IReviewEventBus bus,
        RawPrInboxItem[] openItems)
        => Build(
            config: ConfigStoreFake(ConfigWithSections(
                reviewRequested: true, awaitingAuthor: false, authoredByMe: false, mentioned: false)),
            sections: new FakeSectionQueryRunner(_ =>
                new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
                {
                    ["review-requested"] = openItems
                }),
            events: bus);

    [Fact]
    public async Task RefreshAsync_excludes_closed_merged_and_draft_PRs_from_enrichment()
    {
        // Only open, non-draft PRs should reach IInboxItemEnricher.EnrichAsync.
        // Draft (#2) and recently-closed (#3) PRs must be excluded from the enricher
        // input even though they still appear in the snapshot sections shown to the user.
        var enricher = new CapturingEnricher();
        var when = DateTimeOffset.UtcNow.AddDays(-1);
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { RawOpen(1), RawDraft(2) },
            },
            closed: new[] { RawClosed(3, merged: null, closed: when) });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false,
            mentioned: false, recentlyClosed: true));
        using var sut = Build(
            config: configFake,
            sections: sections,
            aiSelector: new FakeAiSeamSelector(enricher));

        await sut.RefreshAsync(CancellationToken.None);

        // Only PR #1 (open, non-draft) should reach the enricher
        enricher.LastInput.Select(i => i.Reference.Number).Should().BeEquivalentTo(new[] { 1 });
        // Snapshot still contains all three PRs (draft and closed still visible in UI)
        sut.Current!.Sections["review-requested"].Select(i => i.Reference.Number)
            .Should().BeEquivalentTo(new[] { 1, 2 });
        sut.Current.Sections[InboxHistoryConstants.SectionId].Select(i => i.Reference.Number)
            .Should().Contain(3);
    }

    [Fact]
    public async Task InboxEnrichmentsReady_merges_into_current_snapshot_and_publishes_InboxUpdated()
    {
        var bus = new ReviewEventBus();
        var published = new List<IReviewEvent>();
        bus.Subscribe<InboxUpdated>(e => published.Add(e));

        using var orch = BuildOrchestrator(bus: bus, openItems: new[] { RawOpen(1, title: "Add X", desc: "d") });
        await orch.RefreshAsync(default);
        published.Clear();

        var liveToken = InboxEnrichmentContent.Token("Add X", "d");
        bus.Publish(new InboxEnrichmentsReady(new[]
        {
            new InboxEnrichmentResult("octo/repo#1", "Feature", liveToken),        // applies
            new InboxEnrichmentResult("octo/repo#999", "Docs", liveToken),         // not in snapshot → ignored
            new InboxEnrichmentResult("octo/repo#1", "Refactor", "STALE_TOKEN"),   // token mismatch → ignored
            new InboxEnrichmentResult("octo/repo#1", null, liveToken),             // null chip → ignored
        }));

        orch.Current!.Enrichments["octo/repo#1"].CategoryChip.Should().Be("Feature");
        orch.Current!.Enrichments.Should().NotContainKey("octo/repo#999");
        published.OfType<InboxUpdated>().Should().NotBeEmpty(); // fired despite ComputeDiff ignoring enrichments
    }

    [Fact]
    public async Task OnInboxEnrichmentsReady_marks_all_sections_for_a_multi_section_PR()
    {
        // #663: enrichment-apply must mark EVERY section a PR appears in. A PR can
        // legitimately land in two non-paired sections (authored-by-me + awaiting-author
        // are outside the deduplicator's pairs), so the folded PrId→sections map has to
        // preserve every section key. A single-valued PrId→section map would mark only
        // one section and silently drop the other from the published ChangedSectionIds.
        var bus = new ReviewEventBus();
        var published = new List<InboxUpdated>();
        bus.Subscribe<InboxUpdated>(e => published.Add(e));

        var dual = RawOpen(42, "Add X", "d"); // octo/repo#42 — same item in both sections
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["authored-by-me"]  = new[] { dual },
            ["awaiting-author"] = new[] { dual },
        });
        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: false, awaitingAuthor: true, authoredByMe: true, mentioned: false));
        using var orch = Build(config: configFake, sections: sections, events: bus);

        await orch.RefreshAsync(default);
        // Premise: the PR survives in BOTH sections (non-paired → no dedup collapse).
        orch.Current!.Sections["authored-by-me"].Should().ContainSingle(p => p.Reference.Number == 42);
        orch.Current!.Sections["awaiting-author"].Should().ContainSingle(p => p.Reference.Number == 42);
        published.Clear();

        var liveToken = InboxEnrichmentContent.Token("Add X", "d");
        bus.Publish(new InboxEnrichmentsReady(new[]
        {
            new InboxEnrichmentResult("octo/repo#42", "Feature", liveToken),
        }));

        // The single result must flag BOTH sections so the FE clears its working marker
        // on every appearance of the PR — identical to the pre-#663 per-section scan.
        published.Should().ContainSingle();
        published[0].ChangedSectionIds.Should().BeEquivalentTo(new[] { "authored-by-me", "awaiting-author" });
        published[0].NewOrUpdatedPrCount.Should().Be(1); // one chip applied for the single result
    }

    [Fact]
    public async Task RefreshAsync_keeps_authored_draft_visible_in_authored_by_me_with_IsDraft_true()
    {
        // #501 visibility guard: an authored draft must survive enrichment + dedup +
        // materialization and remain in the authored-by-me section with IsDraft=true.
        // Drafts are excluded from AI enrichment INPUT only (RefreshAsync_excludes_...),
        // never from the snapshot the user sees.
        var sections = new FakeSectionQueryRunner(
            _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["authored-by-me"] = new[] { RawOpen(1), RawDraft(2) },
            });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: false, awaitingAuthor: false, authoredByMe: true,
            mentioned: false));
        using var sut = Build(config: configFake, sections: sections);

        await sut.RefreshAsync(CancellationToken.None);

        var authored = sut.Current!.Sections["authored-by-me"];
        authored.Select(i => i.Reference.Number).Should().BeEquivalentTo(new[] { 1, 2 });
        authored.Single(i => i.Reference.Number == 2).IsDraft.Should().BeTrue();
        authored.Single(i => i.Reference.Number == 1).IsDraft.Should().BeFalse();
    }

    // ── AiEnrichmentSettled ───────────────────────────────────────────────────

    [Fact]
    public void InboxSnapshot_AiEnrichmentSettled_DefaultsToEmptyNonNull()
    {
        var snap = new InboxSnapshot(new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
            new Dictionary<string, InboxItemEnrichment>(), DateTimeOffset.UtcNow);
        Assert.NotNull(snap.AiEnrichmentSettled);
        Assert.Empty(snap.AiEnrichmentSettled);
        Assert.NotNull(InboxSnapshot.Empty.AiEnrichmentSettled); // the static Empty must also normalize
        Assert.Empty(InboxSnapshot.Empty.AiEnrichmentSettled);
        var withSet = snap with { AiEnrichmentSettled = new HashSet<string>(StringComparer.Ordinal) { "o/r#1" } };
        Assert.Contains("o/r#1", withSet.AiEnrichmentSettled);
    }

    [Fact]
    public async Task RefreshAsync_AiEnrichmentSettled_ContainsPrIds_OfEnrichedItems()
    {
        // Main path: enricher returns N results (cache hits) → committed snapshot's
        // AiEnrichmentSettled == those N PR-IDs.
        // Use PlaceholderInboxItemEnricher which returns one enrichment per open item.
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawOpen(1, "Add X", "d"), RawOpen(2, "Fix Y", "e") },
        });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false, mentioned: false));
        using var sut = Build(
            config: configFake,
            sections: sections,
            aiSelector: new FakeAiSeamSelector(new PlaceholderInboxItemEnricher()));

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current!.AiEnrichmentSettled.Should().NotBeNull();
        // The two PRs' PrIds should be settled (PlaceholderInboxItemEnricher returns chips for both)
        sut.Current!.AiEnrichmentSettled.Should().HaveCount(2);
        sut.Current!.AiEnrichmentSettled.Should().Contain(sut.Current!.Enrichments.Keys);
    }

    [Fact]
    public async Task OnInboxEnrichmentsReady_AllChipless_StillSetsSettledAndPublishesEvent()
    {
        // A batch whose results are ALL chip-less but live + token-matched must still commit
        // a snapshot with the PRs in AiEnrichmentSettled AND publish InboxUpdated.
        // Previously: if (applied == 0) return; — this test verifies that bug is fixed.
        var bus = new ReviewEventBus();
        var published = new List<IReviewEvent>();
        bus.Subscribe<InboxUpdated>(e => published.Add(e));

        using var orch = BuildOrchestrator(bus: bus, openItems: new[] { RawOpen(1, title: "Add X", desc: "d") });
        await orch.RefreshAsync(default);
        published.Clear();

        var liveToken = InboxEnrichmentContent.Token("Add X", "d");
        // Publish a result with null chip (chip-less but settled)
        bus.Publish(new InboxEnrichmentsReady(new[]
        {
            new InboxEnrichmentResult("octo/repo#1", null, liveToken), // chip-less but live + token-matched
        }));

        // PR should be settled even though no chip landed
        orch.Current!.AiEnrichmentSettled.Should().Contain("octo/repo#1",
            "a chip-less result against a live, token-matched PR must settle that PR");
        // No chip in Enrichments
        orch.Current!.Enrichments.Should().NotContainKey("octo/repo#1",
            "Enrichments stays chip-only; chip-less results don't add an entry");
        // InboxUpdated must fire so the FE clears its working markers
        published.OfType<InboxUpdated>().Should().NotBeEmpty(
            "publishing InboxUpdated is required even when no chip landed");
        // The published event must include the section containing the chip-less PR so the FE
        // knows which rail entry to clear its working marker on.
        published.OfType<InboxUpdated>().Single().ChangedSectionIds.Should().Contain("review-requested",
            "the section holding the chip-less PR must appear in ChangedSectionIds so the FE can clear its working marker");
    }

    // ── #548: AI-mode change invalidates stale enrichments ────────────────────

    // Mode-aware seam selector mirroring the real AiSeamSelector: Preview resolves the
    // placeholder enricher (chips for every PR), Off/Live resolve Noop (no chips). The
    // orchestrator's fire-and-forget RefreshAsync poke after a mode change therefore
    // re-populates with whatever the NEW mode resolves — so the post-Preview state stays
    // chip-less regardless of async timing, matching production.
    private sealed class ModeAwareAiSeamSelector : IAiSeamSelector
    {
        private readonly IConfigStore _config;
        public ModeAwareAiSeamSelector(IConfigStore config) => _config = config;
        public T Resolve<T>() where T : class
        {
            IInboxItemEnricher enricher = _config.Current.Ui.Ai.Mode == AiMode.Preview
                ? new PlaceholderInboxItemEnricher()
                : new NoopInboxItemEnricher();
            return (enricher as T)!;
        }
    }

    // Build an orchestrator seeded (via a real refresh with the placeholder enricher) with a
    // non-empty Enrichments map + AiEnrichmentSettled set, starting from the given AI mode.
    // Returns the SUT, the (recording) bus, and the FakeConfigStore so the caller can flip the
    // mode + raise Changed.
    private static (InboxRefreshOrchestrator Sut, RecordingEventBus Bus, FakeConfigStore Config)
        BuildSeededForAiModeChange(AiMode startMode)
    {
        var bus = new RecordingEventBus();
        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false, mentioned: false)
            with { Ui = AppConfig.Default.Ui with { Ai = AppConfig.Default.Ui.Ai with { Mode = startMode } } });
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawOpen(1, "Add X", "d"), RawOpen(2, "Fix Y", "e") },
        });
        var sut = Build(
            config: configFake,
            sections: sections,
            aiSelector: new ModeAwareAiSeamSelector(configFake),
            events: bus);
        return (sut, bus, configFake);
    }

    [Fact]
    public async Task OnConfigChanged_AiModeChange_ClearsEnrichmentsAndNotifies()
    {
        var (sut, bus, config) = BuildSeededForAiModeChange(AiMode.Preview);
        using var _ = sut;

        await sut.RefreshAsync(CancellationToken.None);
        // Seeded: placeholder enricher gives every open PR a chip + settles it.
        sut.Current!.Enrichments.Should().NotBeEmpty();
        sut.Current!.AiEnrichmentSettled.Should().NotBeEmpty();
        bus.Published.Clear();

        // Flip the AI mode and raise Changed (synchronous, mirrors the PUT /api/preferences thread).
        config.Current = config.Current with
        {
            Ui = config.Current.Ui with { Ai = config.Current.Ui.Ai with { Mode = AiMode.Live } }
        };
        config.RaiseChanged();

        // The cleared state is the observable post-handler state (RefreshAsync poke is fire-and-forget).
        sut.Current!.Enrichments.Should().BeEmpty("a stale Preview chip must not survive an AI-mode change");
        sut.Current!.AiEnrichmentSettled.Should().BeEmpty("the settled set must be cleared so chip-eligible rows show a loading cue");
        bus.Published.OfType<InboxUpdated>().Should().NotBeEmpty(
            "the FE must be force-notified to refetch (ComputeDiff is enrichment-blind)");
    }

    [Fact]
    public async Task OnConfigChanged_SameAiMode_DoesNotClear()
    {
        var (sut, bus, config) = BuildSeededForAiModeChange(AiMode.Preview);
        using var _ = sut;

        await sut.RefreshAsync(CancellationToken.None);
        sut.Current!.Enrichments.Should().NotBeEmpty();
        var enrichmentsBefore = sut.Current!.Enrichments.Count;
        bus.Published.Clear();

        // Raise Changed with the SAME AI mode (e.g. an unrelated theme/accent change).
        config.Current = config.Current with { Ui = config.Current.Ui with { Theme = "dark" } };
        config.RaiseChanged();

        sut.Current!.Enrichments.Should().HaveCount(enrichmentsBefore, "no AI-mode delta means no clear");
        bus.Published.OfType<InboxUpdated>().Should().BeEmpty("no AI-mode delta means no spurious churn");
    }

    [Fact]
    public async Task OnConfigChanged_LiveToPreview_NotifiesFE_AfterSynchronousRepopulate()
    {
        // Live→Preview regression (#508/#548 follow-up): the mode-change handler clears the AI
        // fields, then its fire-and-forget RefreshAsync re-populates with the SYNCHRONOUS
        // placeholder enricher (Preview settles every PR in the main refresh path — it never
        // goes through OnInboxEnrichmentsReady). The PR set is unchanged, so ComputeDiff
        // (enrichment-blind) reports no change and the refresh used to publish NOTHING — leaving
        // the FE stranded on the empty settled set with the working glyph on every row. The
        // refill MUST be announced, mirroring OnInboxEnrichmentsReady's unconditional publish.
        var (sut, bus, config) = BuildSeededForAiModeChange(AiMode.Live);
        using var _ = sut;

        await sut.RefreshAsync(CancellationToken.None);
        // Live resolves Noop in the harness → empty settled, mirroring the cleared start state.
        sut.Current!.AiEnrichmentSettled.Should().BeEmpty();
        bus.Published.Clear();

        // Flip Live → Preview and raise Changed (synchronous, mirrors the PUT thread). All fakes
        // resolve synchronously, so the fire-and-forget RefreshAsync poke runs to completion here.
        config.Current = config.Current with
        {
            Ui = config.Current.Ui with { Ai = config.Current.Ui.Ai with { Mode = AiMode.Preview } }
        };
        config.RaiseChanged();

        // The placeholder enricher settled every open PR…
        sut.Current!.AiEnrichmentSettled.Should().NotBeEmpty(
            "Preview's synchronous placeholder enricher settles every open PR");
        // …and the FE must be told, or it never refetches the now-settled snapshot. The refill
        // carries NewOrUpdatedPrCount == 0: no PR landed via this path, so the FE must not pop the
        // "N new PRs" banner for an enrichment-only refresh.
        var published = bus.Published.OfType<InboxUpdated>().ToList();
        published.Should().NotBeEmpty(
            "the re-populated settled set must be announced even though ComputeDiff is enrichment-blind");
        published.Should().OnlyContain(u => u.NewOrUpdatedPrCount == 0,
            "an enrichment-only refill announces a refetch but reports no new/updated PRs");
    }

    [Fact] // Test 9 — golden-output harness: batch path reproduces the documented REST PrInboxItem shape
    public async Task Batch_path_produces_golden_pr_inbox_items()
    {
        var updated = new DateTimeOffset(2026, 6, 23, 9, 0, 0, TimeSpan.Zero);
        var pushed = new DateTimeOffset(2026, 6, 23, 8, 30, 0, TimeSpan.Zero);
        var rawReviewReq = new RawPrInboxItem(
            Ref(101), "Add feature", "octocat", "acme/api", updated, pushed,
            CommentCount: 0, Additions: 12, Deletions: 3, HeadSha: "head101", CommitCount: 5, ChangedFiles: 4);

        // Batch reader returns hydration verbatim + an older review SHA (so awaiting-author keeps it).
        var batch = new StubBatchReader(new Dictionary<PrReference, BatchPrData>
        {
            [Ref(101)] = new("head101", 12, 3, 5, 4, pushed, null, null, "head100"),
        });

        var sut = Build(
            config: ConfigStoreFake(ConfigWithSections(reviewRequested: true, awaitingAuthor: false,
                                                       authoredByMe: false, mentioned: false)),
            sections: new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = new[] { rawReviewReq },
            }),
            batchReader: batch);

        await sut.RefreshAsync(CancellationToken.None);
        var item = sut.Current!.Sections["review-requested"].Single();

        item.Reference.Should().Be(Ref(101));
        item.HeadSha.Should().Be("head101");
        item.Additions.Should().Be(12);
        item.Deletions.Should().Be(3);
        item.CommitCount.Should().Be(5);
        item.ChangedFiles.Should().Be(4);
        item.PushedAt.Should().Be(pushed);
        item.MergedAt.Should().BeNull();
        item.ClosedAt.Should().BeNull();
    }

    // Minimal IPrBatchReader returning a fixed dictionary (golden-harness fixtures).
    private sealed class StubBatchReader : IPrBatchReader
    {
        private readonly IReadOnlyDictionary<PrReference, BatchPrData> _data;
        public StubBatchReader(IReadOnlyDictionary<PrReference, BatchPrData> data) => _data = data;
        public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
            IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
            => Task.FromResult(_data);
    }

    [Fact]
    public async Task OnConfigChanged_LiveToOff_NotifiesFE_AfterRefill()
    {
        // Live→Off companion to the Live→Preview regression. Off resolves the SYNCHRONOUS Noop
        // enricher, which settles nothing — so unlike Preview there is no chip to land. The refill
        // must STILL be announced so the FE refetches the mode-changed snapshot (in Off the FE then
        // hides chips entirely). Seeding Live (= Noop, empty settled) isolates the forceNotify
        // publish: the clear branch is a no-op, so the only InboxUpdated that can exist is the refill.
        var (sut, bus, config) = BuildSeededForAiModeChange(AiMode.Live);
        using var _ = sut;

        await sut.RefreshAsync(CancellationToken.None);
        sut.Current!.AiEnrichmentSettled.Should().BeEmpty();
        bus.Published.Clear();

        config.Current = config.Current with
        {
            Ui = config.Current.Ui with { Ai = config.Current.Ui.Ai with { Mode = AiMode.Off } }
        };
        config.RaiseChanged();

        // Off settles nothing — the working glyph is moot (the FE hides chips) but the snapshot
        // refetch must still be announced, with NewOrUpdatedPrCount == 0 (no PR landed).
        sut.Current!.AiEnrichmentSettled.Should().BeEmpty("Off uses the Noop enricher — no chips");
        var published = bus.Published.OfType<InboxUpdated>().ToList();
        published.Should().NotBeEmpty(
            "an AI-mode change to Off must announce the refill even though ComputeDiff is enrichment-blind");
        published.Should().OnlyContain(u => u.NewOrUpdatedPrCount == 0,
            "an enrichment-only refill reports no new/updated PRs");
    }

    [Fact]
    public async Task Readiness_only_flip_publishes_InboxUpdated()
    {
        // GitHub recomputes mergeStateStatus asynchronously (e.g. UNKNOWN→CLEAN) without bumping
        // updatedAt — so a readiness-only change must still trigger InboxUpdated.
        var bus = new RecordingEventBus();

        // Batch reader that returns MergeReadiness.None on the first call and MergeReadiness.Ready
        // on the second (simulating a mergeStateStatus flip without any other field change).
        var batchReader = new ReadinessFlipBatchReader();

        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1, "sha1") }
        });

        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false, mentioned: false));
        using var sut = Build(config: configFake, sections: sections, batchReader: batchReader, events: bus);

        await sut.RefreshAsync(CancellationToken.None);   // first: MergeReadiness.None
        bus.Published.Clear();
        await sut.RefreshAsync(CancellationToken.None);   // second: MergeReadiness.Ready

        bus.Published.OfType<InboxUpdated>().Should().NotBeEmpty(
            "a readiness-only flip must publish InboxUpdated even when HeadSha/CommentCount/Ci are unchanged");
    }

    // Batch reader that returns MergeReadiness.None on odd calls and MergeReadiness.Ready on
    // even calls; all other fields are passed through unchanged (HeadSha, CI, CommentCount stay
    // identical so only MergeReadiness differs between refreshes).
    private sealed class ReadinessFlipBatchReader : IPrBatchReader
    {
        private int _call;
        public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
            IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        {
            var isFirstCall = ++_call % 2 == 1;
            var readiness = isFirstCall ? MergeReadiness.None : MergeReadiness.Ready;
            return Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
                items.ToDictionary(i => i.Reference, i => new BatchPrData(
                    i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                    i.PushedAt, i.MergedAt, i.ClosedAt,
                    ViewerLastReviewSha: i.HeadSha + "-prev",
                    MergeReadiness: readiness)));
        }
    }

    // ── ReprobeOnceAsync helpers ─────────────────────────────────────────────────

    // Controllable batch reader for ReprobeOnceAsync and burst tests.
    // EnqueueReadiness: queues a specific readiness for the next read of that ref AND adds the
    //   item to the section rows list.
    // SeedRows: adds items to the section rows list with no queued readiness (defaults to None).
    // ResolveAfter: seeds row + enqueues `attempts` Nones then Ready (burst resolves on attempt N).
    // AlwaysNone: seeds row (with optional headSha override); empty queue → always None.
    // BumpUpdatedAt: mutates the row's UpdatedAt (simulates a comment — headSha unchanged).
    // NewHead: mutates the row's headSha (simulates a new commit → new burst key).
    // BlockOnRead: makes ReadAsync block until ct is cancelled (tests cancellation paths).
    // ReadCount / LastReadRefs / ResetReadCount: observation seams.
    private sealed class ControllableBatchReader : IPrBatchReader
    {
        private readonly Dictionary<PrReference, Queue<MergeReadiness>> _queues = new();
        private readonly List<RawPrInboxItem> _rows = new();
        private bool _blockReads;

        public int ReadCount { get; private set; }
        public IReadOnlyList<PrReference>? LastReadRefs { get; private set; }
        public IReadOnlyList<RawPrInboxItem> Rows => _rows;

        // Optional hook invoked inside ReadAsync (after recording the call, before returning
        // the result). Tests that need to exercise the between-blocks race in ReprobeOnceAsync
        // set this to mutate _current mid-read — simulating a concurrent RefreshAsync that drops
        // a PR between target-selection and the patch block (#655 vanished-row guard).
        public Action? OnRead { get; set; }

        public void EnqueueReadiness(RawPrInboxItem item, MergeReadiness readiness)
        {
            if (!_rows.Any(r => r.Reference == item.Reference))
                _rows.Add(item);
            if (!_queues.TryGetValue(item.Reference, out var q))
                _queues[item.Reference] = q = new Queue<MergeReadiness>();
            q.Enqueue(readiness);
        }

        public void SeedRows(params RawPrInboxItem[] items)
        {
            foreach (var item in items)
                if (!_rows.Any(r => r.Reference == item.Reference))
                    _rows.Add(item);
        }

        public void ResetReadCount() => ReadCount = 0;

        // Task 10 additions ───────────────────────────────────────────────────────

        // Seeds the row + enqueues (attempts) Nones + 1 Ready.
        // On the burst: the initial RefreshAsync read consumes None #1; then each burst
        // attempt consumes one more entry, resolving to Ready on the last.
        public void ResolveAfter(RawPrInboxItem item, int attempts)
        {
            var row = item;
            var idx = _rows.FindIndex(r => r.Reference == item.Reference);
            if (idx >= 0) _rows[idx] = row; else _rows.Add(row);
            if (!_queues.TryGetValue(item.Reference, out var q))
                _queues[item.Reference] = q = new Queue<MergeReadiness>();
            for (var i = 0; i < attempts; i++) q.Enqueue(MergeReadiness.None);
            q.Enqueue(MergeReadiness.Ready);
        }

        // Seeds the row with the given headSha (or item's own headSha if omitted).
        // No queue → ReadAsync returns None on every call.
        public void AlwaysNone(RawPrInboxItem item, string? headSha = null)
        {
            var row = headSha != null ? item with { HeadSha = headSha } : item;
            var idx = _rows.FindIndex(r => r.Reference == item.Reference);
            if (idx >= 0) _rows[idx] = row; else _rows.Add(row);
        }

        // Bumps the row's UpdatedAt while keeping headSha → simulates a comment-only change.
        public void BumpUpdatedAt(RawPrInboxItem item, string headSha)
        {
            var idx = _rows.FindIndex(r => r.Reference == item.Reference);
            var bumped = DateTimeOffset.UtcNow.AddSeconds(1);
            if (idx >= 0)
                _rows[idx] = _rows[idx] with { UpdatedAt = bumped, HeadSha = headSha };
            else
                _rows.Add(item with { UpdatedAt = bumped, HeadSha = headSha });
        }

        // Changes the row's headSha → simulates a new commit (new burst key → re-arms).
        public void NewHead(RawPrInboxItem item, string headSha)
        {
            var idx = _rows.FindIndex(r => r.Reference == item.Reference);
            if (idx >= 0) _rows[idx] = _rows[idx] with { HeadSha = headSha };
            else _rows.Add(item with { HeadSha = headSha });
        }

        // Makes the next ReadAsync call block until ct is cancelled (tests cancellation paths).
        public void BlockOnRead() => _blockReads = true;

        public async Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
            IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        {
            ReadCount++;
            LastReadRefs = items.Select(i => i.Reference).ToList();
            OnRead?.Invoke(); // mid-read hook: fires after recording the call, before returning
            // Block only when there are items — the main RefreshAsync path calls ReadAsync with
            // the full allRawDistinct list (may be non-empty); the burst's ReprobeOnceAsync also
            // calls it with _lastRawSet.  An empty-item call from RefreshAsync on a no-rows
            // scenario returns immediately so the test doesn't deadlock.
            if (_blockReads && items.Count > 0)
            {
                // Block until ct is cancelled (propagates OperationCanceledException so finally
                // blocks in ReprobeOnceAsync release the lock cleanly).
                await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
            }
            return items.ToDictionary(i => i.Reference, i =>
            {
                var readiness = _queues.TryGetValue(i.Reference, out var q) && q.Count > 0
                    ? q.Dequeue()
                    : MergeReadiness.None;
                return new BatchPrData(
                    i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                    i.PushedAt, i.MergedAt, i.ClosedAt,
                    ViewerLastReviewSha: null,
                    MergeReadiness: readiness);
            });
        }
    }

    // Minimal open non-draft PR for reprobe tests (HeadSha non-empty so it survives the
    // orchestrator's HeadSha filter).
    private static RawPrInboxItem Pr(int n) => RawPr(n, "sha" + n);

    // Find a row in the snapshot by its PR reference (across all sections).
    private static PrInboxItem RowFor(InboxSnapshot snap, RawPrInboxItem pr)
        => snap.Sections.Values.SelectMany(s => s).First(p => p.Reference == pr.Reference);

    // Factory for ReprobeOnceAsync / burst tests: wires a ControllableBatchReader whose Rows
    // list is fed dynamically to the section runner, so EnqueueReadiness/SeedRows/AlwaysNone
    // calls before RefreshAsync are automatically visible to the section query.
    // testClock:true injects an immediate burstDelay so the burst runs synchronously in tests
    // (avoids a 31-second real-time wait from the FastBackoff schedule).
    private static (InboxRefreshOrchestrator Orch, ControllableBatchReader Reader, RecordingEventBus Bus)
        NewOrchestrator(bool testClock = false)
    {
        var reader = new ControllableBatchReader();
        var bus = new RecordingEventBus();
        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false, mentioned: false));
        var sections = new FakeSectionQueryRunner(_ =>
            new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = reader.Rows
            });
        Func<TimeSpan, CancellationToken, Task>? burstDelay = testClock
            ? (_, ct) => ct.IsCancellationRequested ? Task.FromCanceled(ct) : Task.CompletedTask
            : null;
        var orch = new InboxRefreshOrchestrator(
            configFake,
            sections,
            reader,
            new FakeCiDetector(),
            new InboxDeduplicator(),
            new FakeAiSeamSelector(new NoopInboxItemEnricher()),
            bus,
            StateStoreFake(),
            new RecordingIdentityCache<InboxSnapshot>(), // #619 cache param
            () => "testuser",
            burstDelay: burstDelay);
        return (orch, reader, bus);
    }

    // ── ReprobeOnceAsync tests ────────────────────────────────────────────────────

    [Fact]
    public async Task Reprobe_patches_resolved_row_and_publishes_InboxUpdated()
    {
        var (orch, reader, bus) = NewOrchestrator();
        reader.EnqueueReadiness(Pr(7), MergeReadiness.None);
        await orch.RefreshAsync(default);
        reader.EnqueueReadiness(Pr(7), MergeReadiness.Ready);
        bus.Published.Clear();

        var more = await orch.ReprobeOnceAsync(default);

        Assert.False(more);
        Assert.Equal(MergeReadiness.Ready, RowFor(orch.Current!, Pr(7)).MergeReadiness);
        Assert.Contains(bus.Published, e => e is InboxUpdated);
    }

    [Fact]
    public async Task Reprobe_passes_full_item_set_not_a_subset()
    {
        // Both PRs end up None after RefreshAsync (no queued readiness → defaults to None).
        // ReprobeOnceAsync must pass the FULL _lastRawSet to ReadAsync (both refs),
        // not just the None-target subset — which would break InboxCacheEviction.PruneAbsent.
        var (orch, reader, _) = NewOrchestrator();
        reader.SeedRows(Pr(7), Pr(8));          // both rows in section; no queued readiness → None
        await orch.RefreshAsync(default);
        await orch.ReprobeOnceAsync(default);

        Assert.NotNull(reader.LastReadRefs);
        Assert.Equal(2, reader.LastReadRefs!.Count);
        Assert.Contains(Pr(7).Reference, reader.LastReadRefs!);
        Assert.Contains(Pr(8).Reference, reader.LastReadRefs!);
    }

    [Fact]
    public async Task Reprobe_skips_a_row_absent_from_current()
    {
        // Exercises the between-blocks vanished-row guard in ReprobeOnceAsync (#655).
        //
        // Timeline:
        //   1. RefreshAsync seeds _current with PR 7 as MergeReadiness.None (a valid target).
        //   2. ReprobeOnceAsync starts: target-selection includes PR 7 (it is None, open, non-draft).
        //   3. ReadAsync is called (inside the first lock); the OnRead hook fires mid-read and
        //      calls SimulateConcurrentDropOf — mutating _current to remove PR 7, simulating a
        //      concurrent RefreshAsync that closed the PR between the two lock blocks.
        //   4. The patch block (second lock) re-reads _current fresh, finds PR 7 absent, and must
        //      NOT resurrect it — the vanished-row guard prevents iterating over a gone row.
        //
        // Previously, this test dropped PR 7 BEFORE ReprobeOnceAsync started, so targets was
        // empty and the method returned false at the no-targets early-exit — never reaching the
        // re-read guard. The OnRead hook ensures the drop happens AFTER target-selection.
        var (orch, reader, _) = NewOrchestrator();
        reader.EnqueueReadiness(Pr(7), MergeReadiness.None);   // PR 7 in snapshot as None
        await orch.RefreshAsync(default);
        reader.EnqueueReadiness(Pr(7), MergeReadiness.Ready);  // next read would return Ready
        reader.ResetReadCount();                                // isolate ReprobeOnceAsync's read

        // Drop PR 7 mid-read: fires inside ReadAsync, after target-selection, before patch block
        reader.OnRead = () => orch.SimulateConcurrentDropOf(Pr(7));

        await orch.ReprobeOnceAsync(default);

        // (a) ReadAsync was invoked — the method did NOT short-circuit at the no-targets early return
        Assert.Equal(1, reader.ReadCount);
        // (b) PR 7 is absent from Current — the patch block did not resurrect a vanished row
        Assert.DoesNotContain(
            orch.Current!.Sections.SelectMany(s => s.Value),
            p => p.Reference == Pr(7).Reference);
    }

    [Fact]
    public async Task Reprobe_no_targets_returns_false_and_does_not_read()
    {
        // PR 8 is Ready after RefreshAsync (queued Ready readiness) — no None targets,
        // so ReprobeOnceAsync must return false without calling ReadAsync.
        var (orch, reader, _) = NewOrchestrator();
        reader.EnqueueReadiness(Pr(8), MergeReadiness.Ready);
        await orch.RefreshAsync(default);
        reader.ResetReadCount();

        Assert.False(await orch.ReprobeOnceAsync(default));
        Assert.Equal(0, reader.ReadCount);
    }

    // ── Task 10: burst lifecycle tests ────────────────────────────────────────────

    [Fact]
    public async Task Refresh_launches_burst_that_resolves_then_stops()
    {
        // ResolveAfter(Pr(7), attempts:2): enqueues None,None,Ready.
        // RefreshAsync consumes the first None → snapshot has MergeReadiness.None.
        // Burst attempt 0: AnyTargetUnderCap (n=0→1) → ReprobeOnceAsync → reads None → more=true.
        // Burst attempt 1: AnyTargetUnderCap (n=1→2) → ReprobeOnceAsync → reads Ready → patches → more=false → stops.
        var (orch, reader, _) = NewOrchestrator(testClock: true);
        reader.ResolveAfter(Pr(7), attempts: 2);
        await orch.RefreshAsync(default);
        await orch.WaitForBurstIdle(TimeSpan.FromSeconds(5));
        Assert.Equal(MergeReadiness.Ready, RowFor(orch.Current!, Pr(7)).MergeReadiness);
    }

    [Fact]
    public async Task Burst_caps_at_five_attempts_for_never_resolving_row()
    {
        // AlwaysNone: empty queue → every read returns None. Burst runs exactly 5 times
        // (FastRetryCap=5, loop exits when attempt reaches 5). BurstAttempts == 5.
        var (orch, reader, _) = NewOrchestrator(testClock: true);
        reader.AlwaysNone(Pr(7));
        await orch.RefreshAsync(default);
        await orch.WaitForBurstIdle(TimeSpan.FromSeconds(40));
        Assert.Equal(5, orch.BurstAttempts(Pr(7)));
    }

    [Fact]
    public async Task Comment_only_UpdatedAt_bump_does_not_rearm_burst()
    {
        // After the burst exhausts its budget for (Pr(7).PrId, "abc"),
        // a comment (UpdatedAt changes, headSha same "abc") must NOT re-arm a new burst:
        // the key is still in _burstAttempts at cap → NewBurstsSinceLastRefresh == 0.
        var (orch, reader, _) = NewOrchestrator(testClock: true);
        reader.AlwaysNone(Pr(7), headSha: "abc");
        await orch.RefreshAsync(default);
        await orch.WaitForBurstIdle(TimeSpan.FromSeconds(40)); // exhaust budget for (ref, abc)
        reader.BumpUpdatedAt(Pr(7), headSha: "abc");           // comment: UpdatedAt ↑, headSha same
        await orch.RefreshAsync(default);
        Assert.Equal(0, orch.NewBurstsSinceLastRefresh());
    }

    [Fact]
    public async Task New_commit_rearms_burst()
    {
        // After the budget for (Pr(7).PrId, "abc") is exhausted, a new commit (headSha "def")
        // produces a new key → not in _burstAttempts → re-armed → NewBurstsSinceLastRefresh >= 1.
        var (orch, reader, _) = NewOrchestrator(testClock: true);
        reader.AlwaysNone(Pr(7), headSha: "abc");
        await orch.RefreshAsync(default);
        await orch.WaitForBurstIdle(TimeSpan.FromSeconds(40)); // exhaust budget for (ref, abc)
        reader.NewHead(Pr(7), headSha: "def");
        await orch.RefreshAsync(default);
        Assert.True(orch.NewBurstsSinceLastRefresh() >= 1);
    }

    [Fact]
    public async Task New_refresh_cancels_prior_in_flight_pass_and_Dispose_cancels()
    {
        // Verify that a second refresh genuinely cancels a burst that is PARKED in its burstDelay.
        //
        // Design:
        //   - A TCS-based burstDelay signals when first entered, then blocks indefinitely
        //     on the CancellationToken. This parks burst A in the delay (lock-free window)
        //     without blocking ReadAsync (which holds the writerLock).
        //   - ONE seeded None row ensures AnyTargetUnderCap() returns true and the burst
        //     actually starts and reaches the delay.
        //   - After confirming burst A is parked, we capture its Task, then call pass B.
        //   - Pass B's LaunchReprobeBurst cancels burst A's CTS → Task.Delay(Infinite, ct)
        //     throws OperationCanceledException → burst A returns promptly.
        //   - Assert: PriorPassWasCancelled + burst A's Task finishes quickly (not 31s
        //     of real backoff). Dispose cancels pass B's CTS; must not throw ObjectDisposedException.
        var firstDelayEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Func<TimeSpan, CancellationToken, Task> controllableDelay = async (_, ct) =>
        {
            firstDelayEntered.TrySetResult(true); // idempotent: subsequent invocations (burst B) are no-ops
            await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
        };

        var reader = new ControllableBatchReader();
        var bus = new RecordingEventBus();
        var configFake = ConfigStoreFake(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false, mentioned: false));
        var sections = new FakeSectionQueryRunner(_ =>
            new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["review-requested"] = reader.Rows,
            });
        var orch = new InboxRefreshOrchestrator(
            configFake, sections, reader,
            new FakeCiDetector(), new InboxDeduplicator(),
            new FakeAiSeamSelector(new NoopInboxItemEnricher()),
            bus, StateStoreFake(),
            new RecordingIdentityCache<InboxSnapshot>(), // #619 cache param
            () => "testuser",
            burstDelay: controllableDelay);

        // ONE open non-draft None row so AnyTargetUnderCap() is true and burst A starts.
        reader.AlwaysNone(Pr(1));

        // Pass A: RefreshAsync finishes, LaunchReprobeBurst spawns burst A.
        await orch.RefreshAsync(default);

        // Wait for burst A to genuinely enter its burstDelay (confirming it is in-flight).
        Assert.True(
            await firstDelayEntered.Task.WaitAsync(TimeSpan.FromSeconds(5)),
            "burst A must reach burstDelay within 5s");

        // Capture burst A's Task handle before pass B's LaunchReprobeBurst replaces _burstTask.
        var passABurstTask = orch.WaitForBurstIdle(TimeSpan.Zero);

        // Pass B: LaunchReprobeBurst cancels burst A's CTS → Task.Delay(Infinite, ct) throws OCE.
        await orch.RefreshAsync(default);

        Assert.True(orch.PriorPassWasCancelled,
            "pass B must have cancelled burst A's in-flight CTS");

        // Burst A must complete promptly via OperationCanceledException (not run all 5 delays).
        await passABurstTask.WaitAsync(TimeSpan.FromSeconds(5));

        // Dispose cancels pass B's CTS. Must not throw ObjectDisposedException.
        orch.Dispose();
    }
}
