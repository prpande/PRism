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
    public async Task State_json_reads_propagate_to_inbox_items()
    {
        // Arrange: state.json has a session entry for PR #1 in acme/api
        var sessionKey = "acme/api#1";
        var sessionState = new ReviewSessionState(
            LastViewedHeadSha: "abc",
            LastSeenCommentId: "12345",
            PendingReviewId: null,
            PendingReviewCommitOid: null);
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
