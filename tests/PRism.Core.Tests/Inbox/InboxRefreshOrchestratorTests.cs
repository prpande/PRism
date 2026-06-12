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
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, headSha, 1);

    private static RawPrInboxItem RawClosed(int n, DateTimeOffset? merged, DateTimeOffset? closed, string headSha = "")
        => new(Ref(n), $"PR #{n}", "author", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, headSha, 1,
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
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "", 1,
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

    // PR enricher: identity (returns the same items unchanged)
    private sealed class IdentityPrEnricher : IPrEnricher
    {
        public Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
            => Task.FromResult(items);
    }

    // PR enricher that simulates a dropped enrichment (e.g. GitHub 404): it omits
    // the given PR numbers from its output, so those refs fall back to the raw
    // Search item (null close timestamps + empty headSha).
    private sealed class DropEnricher : IPrEnricher
    {
        private readonly HashSet<int> _drop;
        public DropEnricher(params int[] drop) => _drop = drop.ToHashSet();
        public Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
            => Task.FromResult<IReadOnlyList<RawPrInboxItem>>(
                items.Where(i => !_drop.Contains(i.Reference.Number)).ToList());
    }

    // Awaiting-author filter: returns all candidates unchanged
    private sealed class PassthroughAwaitingAuthorFilter : IAwaitingAuthorFilter
    {
        public Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
            string viewerLogin, IReadOnlyList<RawPrInboxItem> candidates, CancellationToken ct)
            => Task.FromResult(candidates);
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
        IPrEnricher? enricher = null,
        IAwaitingAuthorFilter? awaitingFilter = null,
        ICiFailingDetector? ciDetector = null,
        IInboxDeduplicator? dedupe = null,
        IAiSeamSelector? aiSelector = null,
        IReviewEventBus? events = null,
        IAppStateStore? stateStore = null,
        Func<string>? viewerLogin = null)
        => new(
            config ?? ConfigStoreFake(),
            sections ?? new FakeSectionQueryRunner(_ =>
                new Dictionary<string, IReadOnlyList<RawPrInboxItem>>()),
            enricher ?? new IdentityPrEnricher(),
            awaitingFilter ?? new PassthroughAwaitingAuthorFilter(),
            ciDetector ?? new FakeCiDetector(),
            dedupe ?? new InboxDeduplicator(),
            aiSelector ?? new FakeAiSeamSelector(new NoopInboxItemEnricher()),
            events ?? new RecordingEventBus(),
            stateStore ?? StateStoreFake(),
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
            enricher: new DropEnricher(7)); // #7 enrichment drops → fallback to raw

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
}
