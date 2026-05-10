using FluentAssertions;
using Moq;
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
// Disambiguate against PRism.Core.Contracts.DraftComment/DraftReply (AI-seam DTOs):
using StateDraftComment = PRism.Core.State.DraftComment;
using StateDraftReply = PRism.Core.State.DraftReply;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxRefreshOrchestratorTests
{
    // ── Helpers ────────────────────────────────────────────────────────────────

    private static PrReference Ref(int n, string owner = "acme", string repo = "api")
        => new(owner, repo, n);

    private static RawPrInboxItem RawPr(int n, string headSha = "sha", string owner = "acme", string repo = "api")
        => new(Ref(n, owner, repo), $"PR #{n}", "author", $"{owner}/{repo}",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, headSha, 1);

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

    // Section runner: returns a fixed dictionary of sections → items
    private sealed class FakeSectionQueryRunner : ISectionQueryRunner
    {
        private readonly Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> _factory;
        public FakeSectionQueryRunner(
            Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> factory)
            => _factory = factory;
        public Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
            IReadOnlySet<string> visibleSectionIds, CancellationToken ct)
            => Task.FromResult(_factory(visibleSectionIds));
    }

    // PR enricher: identity (returns the same items unchanged)
    private sealed class IdentityPrEnricher : IPrEnricher
    {
        public Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
            => Task.FromResult(items);
    }

    // Awaiting-author filter: returns all candidates unchanged
    private sealed class PassthroughAwaitingAuthorFilter : IAwaitingAuthorFilter
    {
        public Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
            string viewerLogin, IReadOnlyList<RawPrInboxItem> candidates, CancellationToken ct)
            => Task.FromResult(candidates);
    }

    // CI detector: returns all items with CiStatus.None
    private sealed class NoneciDetector : ICiFailingDetector
    {
        public Task<IReadOnlyList<(RawPrInboxItem Item, CiStatus Ci)>> DetectAsync(
            IReadOnlyList<RawPrInboxItem> authoredItems, CancellationToken ct)
            => Task.FromResult<IReadOnlyList<(RawPrInboxItem, CiStatus)>>(
                authoredItems.Select(i => (i, CiStatus.None)).ToList());
    }

    private static AppConfig DefaultConfig() => AppConfig.Default;

    private static AppConfig ConfigWithSections(
        bool reviewRequested = true,
        bool awaitingAuthor = true,
        bool authoredByMe = true,
        bool mentioned = true,
        bool ciFailing = true)
        => AppConfig.Default with
        {
            Inbox = new InboxConfig(
                Deduplicate: false,
                Sections: new InboxSectionsConfig(
                    reviewRequested, awaitingAuthor, authoredByMe, mentioned, ciFailing),
                ShowHiddenScopeFooter: true)
        };

    private static Mock<IConfigStore> ConfigStoreMock(AppConfig? config = null)
    {
        var mock = new Mock<IConfigStore>();
        mock.SetupGet(c => c.Current).Returns(config ?? DefaultConfig());
        return mock;
    }

    private static Mock<IAppStateStore> StateStoreMock(AppState? state = null)
    {
        var mock = new Mock<IAppStateStore>();
        mock.Setup(s => s.LoadAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(state ?? AppState.Default);
        return mock;
    }

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
            config ?? ConfigStoreMock().Object,
            sections ?? new FakeSectionQueryRunner(_ =>
                new Dictionary<string, IReadOnlyList<RawPrInboxItem>>()),
            enricher ?? new IdentityPrEnricher(),
            awaitingFilter ?? new PassthroughAwaitingAuthorFilter(),
            ciDetector ?? new NoneciDetector(),
            dedupe ?? new InboxDeduplicator(),
            aiSelector ?? new FakeAiSeamSelector(new NoopInboxItemEnricher()),
            events ?? new RecordingEventBus(),
            stateStore ?? StateStoreMock().Object,
            viewerLogin ?? (() => "testuser"));

    // ── Tests ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task First_refresh_completes_TCS_and_publishes_event()
    {
        var bus = new RecordingEventBus();
        var sectionIds = new[] { "review-requested", "awaiting-author", "authored-by-me", "mentioned", "ci-failing" };
        var sections = new FakeSectionQueryRunner(_ => AllSections(2, sectionIds));

        var configMock = ConfigStoreMock(ConfigWithSections());
        using var sut = Build(
            config: configMock.Object,
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

        var configMock = ConfigStoreMock(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: true,
            mentioned: false, ciFailing: false));
        using var sut = Build(config: configMock.Object, sections: sections, events: bus);

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

        var configMock = ConfigStoreMock(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false,
            mentioned: false, ciFailing: false));
        using var sut = Build(config: configMock.Object, sections: sections, events: bus);

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

        var configMock = ConfigStoreMock(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: true,
            mentioned: false, ciFailing: false));
        using var sut = Build(config: configMock.Object, sections: sections);

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
    public async Task RefreshAsync_when_AuthoredByMe_disabled_but_CiFailing_enabled_does_not_emit_authored_by_me_section()
    {
        // The CI detector requires the authored-by-me superset to compute the ci-failing
        // subset, so ResolveVisibleSections() forces "authored-by-me" into the visible set
        // even when the user disabled that section. The snapshot, however, must respect
        // the user's preference and only surface "ci-failing".
        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["authored-by-me"] = new[] { RawPr(1, "sha-1"), RawPr(2, "sha-2") }
        });

        // CI detector reports PR #1 as Failing, PR #2 as Passing
        var ciDetector = new Mock<ICiFailingDetector>();
        ciDetector.Setup(d => d.DetectAsync(It.IsAny<IReadOnlyList<RawPrInboxItem>>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((IReadOnlyList<RawPrInboxItem> items, CancellationToken _) =>
                (IReadOnlyList<(RawPrInboxItem, CiStatus)>)items
                    .Select(i => (i, i.Reference.Number == 1 ? CiStatus.Failing : CiStatus.None))
                    .ToList());

        var configMock = ConfigStoreMock(ConfigWithSections(
            reviewRequested: false, awaitingAuthor: false, authoredByMe: false,
            mentioned: false, ciFailing: true));
        using var sut = Build(
            config: configMock.Object,
            sections: sections,
            ciDetector: ciDetector.Object);

        await sut.RefreshAsync(CancellationToken.None);

        sut.Current.Should().NotBeNull();
        sut.Current!.Sections.Should().NotContainKey("authored-by-me");
        sut.Current.Sections.Should().ContainKey("ci-failing");
        sut.Current.Sections["ci-failing"].Should().ContainSingle()
            .Which.Reference.Number.Should().Be(1);
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

        var configMock = ConfigStoreMock(ConfigWithSections(
            reviewRequested: true, awaitingAuthor: false, authoredByMe: false,
            mentioned: false, ciFailing: false));
        using var sut = Build(config: configMock.Object, sections: sections, events: bus);

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

        var configMock = ConfigStoreMock(ConfigWithSections(
            reviewRequested: false, awaitingAuthor: true, authoredByMe: true,
            mentioned: false, ciFailing: false));
        using var sut = Build(
            config: configMock.Object,
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
        var sessionKey = "acme/api#1";
        var sessionState = new ReviewSessionState(
            LastViewedHeadSha: "abc",
            LastSeenCommentId: "12345",
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<StateDraftComment>(),
            DraftReplies: new List<StateDraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
        var appState = AppState.Default with
        {
            ReviewSessions = new Dictionary<string, ReviewSessionState>
            {
                [sessionKey] = sessionState
            }
        };

        var sections = new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1, "sha-head") }
        });

        var stateStoreMock = StateStoreMock(appState);
        using var sut = Build(sections: sections, stateStore: stateStoreMock.Object);

        await sut.RefreshAsync(CancellationToken.None);

        var items = sut.Current!.Sections["review-requested"];
        var pr1 = items.Single(p => p.Reference.Number == 1);
        pr1.LastViewedHeadSha.Should().Be("abc");
        pr1.LastSeenCommentId.Should().Be(12345L);
    }
}
