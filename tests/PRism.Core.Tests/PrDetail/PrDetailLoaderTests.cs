using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

// Spec § 6.1 + § 6.4 + Q5. PrDetailLoader is a concrete class — there is no
// IPrDetailLoader interface. Tests substitute IPrReader directly via constructor
// injection (the loader's only meaningful collaborator that varies between tests).
public class PrDetailLoaderTests
{
    private static readonly PrReference Pr1 = new("owner", "repo", 1);

    private static PrDetailDto MakeDetail(string headSha = "head1", string baseSha = "base1", bool isMerged = false) =>
        new(
            Pr: new Pr(
                Reference: Pr1,
                Title: "Test PR",
                Body: "body",
                Author: "alice",
                State: isMerged ? "MERGED" : "OPEN",
                HeadSha: headSha,
                BaseSha: baseSha,
                HeadBranch: "feat/x",
                BaseBranch: "main",
                Mergeability: "MERGEABLE",
                CiSummary: "passing",
                IsMerged: isMerged,
                IsClosed: false,
                OpenedAt: DateTimeOffset.UtcNow,
                MergedAt: isMerged ? DateTimeOffset.UtcNow : null),
            ClusteringQuality: ClusteringQuality.Ok,                  // overwritten by loader
            Iterations: null,                                          // overwritten by loader
            Commits: Array.Empty<CommitDto>(),                         // overwritten by loader
            RootComments: Array.Empty<IssueCommentDto>(),
            ReviewComments: Array.Empty<ReviewThreadDto>(),
            TimelineCapHit: false,
            ViewerReview: null);

    private static ClusteringInput MakeTimeline(int commitCount, string shaPrefix = "c") =>
        new(
            Commits: Enumerable.Range(0, commitCount)
                .Select(i => new ClusteringCommit(
                    Sha: $"{shaPrefix}{i:D3}",
                    CommittedDate: DateTimeOffset.UtcNow.AddSeconds(i * 60),
                    Message: $"commit {i}",
                    Additions: 10,
                    Deletions: 1,
                    ChangedFiles: new[] { $"file{i}.cs" }))
                .ToArray(),
            ForcePushes: Array.Empty<ClusteringForcePush>(),
            ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
            AuthorPrComments: Array.Empty<ClusteringAuthorComment>());

    private static PrDetailLoader MakeLoader(
        FakePrDetailReviewService review,
        IIterationClusteringStrategy? clusterer = null,
        FakeConfigStore? configStore = null,
        IReviewEventBus? bus = null) =>
        new(
            review,
            clusterer ?? new RecordingClusterer(new List<string>()),
            new IterationClusteringCoefficients(),
            configStore ?? new FakeConfigStore(),
            bus ?? new ReviewEventBus());

    [Fact]
    public async Task LoadAsync_calls_PollActivePr_then_GetPrDetail_then_GetTimeline_then_clusters_in_order()
    {
        // Spec § 6.1: PollActivePr first (cheap REST probe to learn current head; lets the
        // cache short-circuit cold loads on cache hits without paying for the heavy GraphQL
        // round-trip). Then GetPrDetail + GetTimeline + Cluster on cache miss.
        var calls = new List<string>();
        var review = new FakePrDetailReviewService(calls);
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review, clusterer: new RecordingClusterer(calls));

        await loader.LoadAsync(Pr1, CancellationToken.None);

        calls.Should().Equal("PollActivePr", "GetPrDetail", "GetTimeline", "Cluster");
    }

    [Fact]
    public async Task LoadAsync_caches_by_prRef_and_headSha_so_second_call_skips_GetPrDetail()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review);

        var s1 = await loader.LoadAsync(Pr1, CancellationToken.None);
        var s2 = await loader.LoadAsync(Pr1, CancellationToken.None);

        s1.Should().BeSameAs(s2);
        review.GetPrDetailCallCount.Should().Be(1, because: "second call hit the cache");
        review.PollActivePrCallCount.Should().Be(2, because: "every load polls the current head before probing the cache");
    }

    [Fact]
    public async Task LoadAsync_re_fetches_when_head_sha_advances_remotely()
    {
        // Per-PR cache key is (prRef, headSha, generation). When the poll surfaces a new
        // head SHA, the cache miss forces a fresh GetPrDetail.
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        var loader = MakeLoader(review);

        await loader.LoadAsync(Pr1, CancellationToken.None);

        // Author force-pushes; head moves.
        review.DefaultPollResponse = new ActivePrPollSnapshot("head2", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head2");

        await loader.LoadAsync(Pr1, CancellationToken.None);

        review.GetPrDetailCallCount.Should().Be(2, because: "head SHA changed; cached snapshot is stale");
    }

    [Fact]
    public async Task LoadAsync_re_fetches_after_ActivePrUpdated_when_head_sha_unchanged()
    {
        // #116: a background auto-merge (or close) does NOT change the head SHA, so the
        // (prRef, headSha, generation) cache key alone would re-serve the stale "open"
        // snapshot on every reload. The loader subscribes to ActivePrUpdated and evicts
        // the PR's snapshot on the poller's signal, so the next LoadAsync re-fetches and
        // surfaces IsMerged — even though the head SHA never moved.
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        var open = await loader.LoadAsync(Pr1, CancellationToken.None);
        open!.Detail.Pr.IsMerged.Should().BeFalse();
        review.GetPrDetailCallCount.Should().Be(1);

        // PR merges in the background — head SHA unchanged. The poller observes the
        // transition and publishes; the detail now reports merged.
        review.DefaultDetailResponse = MakeDetail(headSha: "head1", isMerged: true);
        bus.Publish(new ActivePrUpdated(
            Pr1,
            HeadShaChanged: false,
            CommentCountChanged: false,
            NewHeadSha: null,
            CommentCountDelta: 0,
            IsMerged: true,
            IsClosed: false));

        var merged = await loader.LoadAsync(Pr1, CancellationToken.None);
        merged!.Detail.Pr.IsMerged.Should().BeTrue("the merge event evicted the stale open snapshot");
        review.GetPrDetailCallCount.Should().Be(2, because: "eviction forced a fresh fetch despite the unchanged head SHA");
    }

    [Fact]
    public async Task LoadAsync_evicts_snapshot_after_RootCommentPostedBusEvent()
    {
        // #353: a posted PR-root comment is a GitHub issue comment — it does NOT change the
        // head SHA, so the (prRef, headSha, generation) cache key alone would re-serve the
        // stale pre-post snapshot on the SSE-driven reload. The loader subscribes to
        // RootCommentPostedBusEvent and evicts the PR's snapshot immediately, so the reload
        // re-fetches fresh detail instead of waiting for the ActivePrPoller's CommentCountChanged.
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        loader.TryGetCachedSnapshot(Pr1).Should().NotBeNull();

        bus.Publish(new RootCommentPostedBusEvent(Pr1, 0L));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .BeNull("a posted root comment must evict the snapshot so the reload re-fetches fresh detail");
    }

    [Fact]
    public async Task RootCommentPostedBusEvent_for_other_prRef_does_not_evict_this_snapshot()
    {
        // Eviction is scoped to evt.PrRef — a root comment posted on a different PR must not
        // drop this PR's cached snapshot (which would 422 /file & /viewed for no reason).
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);

        bus.Publish(new RootCommentPostedBusEvent(new PrReference("owner", "repo", 2), 0L));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .NotBeNull("a different PR's root-comment post must not evict this PR's snapshot");
    }

    [Fact]
    public async Task LoadAsync_evicts_snapshot_after_SingleCommentPostedBusEvent()
    {
        // #450: a posted inline comment/reply does NOT change the head SHA, so the
        // (prRef, headSha, generation) key would re-serve the stale pre-post snapshot on the
        // SSE-driven reload — the new thread would be missing until a manual reload. The loader
        // subscribes to SingleCommentPostedBusEvent and evicts immediately. (Invalidate, not
        // RefreshAsync: the bus is synchronous and fires inside the comment-POST — see spec §2.2.)
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        loader.TryGetCachedSnapshot(Pr1).Should().NotBeNull();

        bus.Publish(new SingleCommentPostedBusEvent(Pr1, 0L));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .BeNull("a posted single comment must evict the snapshot so the reload re-fetches fresh detail");
    }

    [Fact]
    public async Task SingleCommentPostedBusEvent_for_other_prRef_does_not_evict_this_snapshot()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);

        bus.Publish(new SingleCommentPostedBusEvent(new PrReference("owner", "repo", 2), 0L));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .NotBeNull("a different PR's single-comment post must not evict this PR's snapshot");
    }

    [Fact]
    public async Task LoadAsync_evicts_snapshot_after_DraftSubmitted()
    {
        // #392: a review submit posts threads/replies + the PR-root comment but does NOT change
        // the head SHA, so the (prRef, headSha, generation) cache key alone would re-serve the
        // stale pre-submit snapshot on the post-submit reload — the #353 bug class, for submit.
        // The loader subscribes to DraftSubmitted (published only on full submit success, after the
        // server-side draft clear) and evicts the PR's snapshot so the reload re-fetches fresh detail.
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        loader.TryGetCachedSnapshot(Pr1).Should().NotBeNull();

        bus.Publish(new DraftSubmitted(Pr1));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .BeNull("a submitted review must evict the snapshot so the reload re-fetches fresh detail");
    }

    [Fact]
    public async Task DraftSubmitted_for_other_prRef_does_not_evict_this_snapshot()
    {
        // Eviction is scoped to evt.PrRef — a review submitted on a different PR must not drop
        // this PR's cached snapshot (which would 422 /file & /viewed for no reason).
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);

        bus.Publish(new DraftSubmitted(new PrReference("owner", "repo", 2)));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .NotBeNull("a different PR's review submit must not evict this PR's snapshot");
    }

    [Fact]
    public async Task LoadAsync_does_not_evict_snapshot_on_no_op_ActivePrUpdated_event()
    {
        // #116 / PR #150 review: the poller's first poll on a quiet PR publishes an
        // ActivePrUpdated with no head/comment delta and no done-state. That must NOT
        // evict the freshly cached snapshot — otherwise /file and /viewed (which read
        // TryGetCachedSnapshot synchronously) would return 422 snapshot-evicted ~30s
        // after the page opens, recurring on every quiet poll.
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        review.GetPrDetailCallCount.Should().Be(1);

        // Quiet hydration event: no deltas, still open (matches the cached state).
        bus.Publish(new ActivePrUpdated(
            Pr1,
            HeadShaChanged: false,
            CommentCountChanged: false,
            NewHeadSha: null,
            CommentCountDelta: 0,
            IsMerged: false,
            IsClosed: false));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .NotBeNull("a no-op hydration event must not evict the cached snapshot");
        await loader.LoadAsync(Pr1, CancellationToken.None);
        review.GetPrDetailCallCount.Should()
            .Be(1, because: "the cached snapshot survived the no-op event, so the second load hit the cache");
    }

    [Fact]
    public async Task LoadAsync_returns_existing_realKey_snapshot_when_pollKey_lags_real_head()
    {
        // Establishes a snapshot under realKey="head-fresh" via accurate initial poll, then
        // forces the poll to return an older head SHA. The loader must re-probe the cache by
        // realKey (computed from the detail's actual head) before paying for timeline +
        // clustering — a stale-poller race must reuse the existing snapshot.
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head-fresh", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head-fresh");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review);

        var first = await loader.LoadAsync(Pr1, CancellationToken.None);
        review.GetTimelineCallCount.Should().Be(1, because: "initial cold-load fetched timeline");

        // Now force the poller into the stale-lag state: poll returns "head-old", detail
        // still says "head-fresh".
        review.DefaultPollResponse = new ActivePrPollSnapshot("head-old", "MERGEABLE", "OPEN", 0, 0);

        var second = await loader.LoadAsync(Pr1, CancellationToken.None);

        second.Should().BeSameAs(first,
            because: "realKey re-probe must reuse the existing snapshot rather than re-cluster");
        review.GetTimelineCallCount.Should().Be(1,
            because: "timeline + clustering must be skipped on the realKey hit");
    }

    [Fact]
    public async Task InvalidateAll_forces_reload_on_next_LoadAsync()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        loader.InvalidateAll();
        await loader.LoadAsync(Pr1, CancellationToken.None);

        review.GetPrDetailCallCount.Should().Be(2);
    }

    [Fact]
    public async Task InvalidateAll_clears_diff_memo_so_path_lookup_returns_false()
    {
        // The InvalidateAll docstring says the diff memo is also cleared. Without a test,
        // a future refactor could quietly drop the `_diffs.Clear()` call and a stale
        // path-in-diff lookup would silently let an authz check pass against a stale diff.
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review);

        await loader.GetOrFetchDiffAsync(Pr1, new DiffRangeRequest("base1", "head1"), CancellationToken.None);
        loader.IsPathInAnyCachedDiff(Pr1, "src/Foo.cs").Should().BeTrue();

        loader.InvalidateAll();

        loader.IsPathInAnyCachedDiff(Pr1, "src/Foo.cs").Should().BeFalse(
            because: "InvalidateAll must clear the diff memo, not just the snapshot cache");
    }

    // Q5 — ClusteringQuality determination tests.

    [Fact]
    public async Task LoadAsync_returns_ClusteringQuality_Ok_with_single_iteration_when_timeline_has_one_commit()
    {
        // Calibration 2026-05-18: single-commit PRs (doc-fixes, reverts) are legitimately "one
        // unit of work" and should render the iteration view, not the commit-picker fallback.
        // DetermineQuality only short-circuits to Low on Commits.Count == 0 now — at the
        // LOADER level, a 1-commit timeline now flows past the short-circuit and is passed to
        // whatever IIterationClusteringStrategy is wired in. This unit test verifies that
        // loader contract by injecting a RecordingClusterer that returns one cluster (the
        // pre-baked `singleClusterResult` below), so the LOADER's behavior given a
        // single-cluster strategy result is the thing under test. The end-to-end fact that
        // the real WeightedDistanceClusteringStrategy returns one cluster on length-1 input
        // is covered separately by `Single_commit_returns_one_cluster` in
        // WeightedDistanceClusteringStrategyTests + the live PR #1 corpus test.
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(1);
        var singleClusterResult = new[]
        {
            new IterationCluster(1, BeforeSha: "sha0", AfterSha: "sha0", CommitShas: new[] { "sha0" }),
        };
        var loader = MakeLoader(review, clusterer: new RecordingClusterer(new List<string>(), result: singleClusterResult));

        var snapshot = await loader.LoadAsync(Pr1, CancellationToken.None);

        snapshot.Should().NotBeNull();
        snapshot!.Detail.ClusteringQuality.Should().Be(ClusteringQuality.Ok);
        snapshot.Detail.Iterations.Should().NotBeNull().And.HaveCount(1);
        snapshot.Detail.Commits.Should().HaveCount(1);
    }

    [Fact]
    public async Task LoadAsync_returns_ClusteringQuality_Low_when_strategy_returns_null_degenerate_detector()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var degenerate = new RecordingClusterer(new List<string>(), result: null);
        var loader = MakeLoader(review, clusterer: degenerate);

        var snapshot = await loader.LoadAsync(Pr1, CancellationToken.None);

        snapshot!.Detail.ClusteringQuality.Should().Be(ClusteringQuality.Low);
        snapshot.Detail.Iterations.Should().BeNull();
        snapshot.Detail.Commits.Should().HaveCount(5);
    }

    [Fact]
    public async Task LoadAsync_returns_ClusteringQuality_Low_when_clusteringDisabled_config_flag_set()
    {
        // Q5 calibration-failure escape hatch: iterations.clusteringDisabled = true → the
        // strategy is bypassed entirely; every PR gets ClusteringQuality.Low.
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var configStore = new FakeConfigStore
        {
            Current = AppConfig.Default with
            {
                Iterations = AppConfig.Default.Iterations with { ClusteringDisabled = true }
            }
        };
        var calls = new List<string>();
        var clusterer = new RecordingClusterer(calls);
        var loader = MakeLoader(review, clusterer: clusterer, configStore: configStore);

        var snapshot = await loader.LoadAsync(Pr1, CancellationToken.None);

        snapshot!.Detail.ClusteringQuality.Should().Be(ClusteringQuality.Low);
        snapshot.Detail.Iterations.Should().BeNull();
        calls.Should().NotContain("Cluster", because: "clusteringDisabled bypasses the strategy");
    }

    [Fact]
    public async Task LoadAsync_returns_ClusteringQuality_Ok_for_healthy_multi_commit_pr()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var clusters = new[]
        {
            new IterationCluster(1, "c000", "c002", new[] { "c000", "c001", "c002" }),
            new IterationCluster(2, "c003", "c004", new[] { "c003", "c004" }),
        };
        var clusterer = new RecordingClusterer(new List<string>(), result: clusters);
        var loader = MakeLoader(review, clusterer: clusterer);

        var snapshot = await loader.LoadAsync(Pr1, CancellationToken.None);

        snapshot!.Detail.ClusteringQuality.Should().Be(ClusteringQuality.Ok);
        snapshot.Detail.Iterations.Should().HaveCount(2);
        snapshot.Detail.Iterations![0].Number.Should().Be(1);
        snapshot.Detail.Iterations[0].BeforeSha.Should().Be("c000");
        snapshot.Detail.Iterations[0].AfterSha.Should().Be("c002");
        snapshot.Detail.Iterations[0].Commits.Should().HaveCount(3);
        snapshot.Detail.Iterations[0].HasResolvableRange.Should().BeTrue(
            because: "both endpoints exist in the timeline's commit set");
    }

    [Fact]
    public async Task LoadAsync_marks_iteration_as_unresolvable_range_when_endpoint_sha_is_GC_collected()
    {
        // Force-pushed iterations may have endpoint SHAs that were GC'd from the timeline.
        // The cluster's Before/After SHAs aren't in the (post-force-push) commit set, so
        // HasResolvableRange should be false; UI renders "Iter N (snapshot lost)".
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var clusters = new[]
        {
            // GC'd endpoint not present in the timeline's c000..c004 set:
            new IterationCluster(1, BeforeSha: "deadbeef", AfterSha: "c002",
                CommitShas: new[] { "c000", "c001", "c002" }),
        };
        var clusterer = new RecordingClusterer(new List<string>(), result: clusters);
        var loader = MakeLoader(review, clusterer: clusterer);

        var snapshot = await loader.LoadAsync(Pr1, CancellationToken.None);

        snapshot!.Detail.Iterations![0].HasResolvableRange.Should().BeFalse();
    }

    // P2.29 — ConfigStore.Changed wiring.

    [Fact]
    public async Task ConfigStore_Changed_event_invalidates_loader_cache()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var configStore = new FakeConfigStore();
        var loader = MakeLoader(review, configStore: configStore);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        configStore.RaiseChanged();
        await loader.LoadAsync(Pr1, CancellationToken.None);

        review.GetPrDetailCallCount.Should().Be(2,
            because: "config change must invalidate cache so coefficient hot-reloads re-cluster");
    }

    // Option B — diff memo. PrDetailLoader caches DiffDto by (prRef, headSha, range) lazily
    // populated by GetOrFetchDiffAsync. Path-in-diff lookups (used by /file authz in Task 4
    // endpoints) consult the memo without re-fetching.

    [Fact]
    public async Task GetOrFetchDiffAsync_caches_per_range_no_redundant_fetches()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review);

        var range = new DiffRangeRequest("base1", "head1");
        var d1 = await loader.GetOrFetchDiffAsync(Pr1, range, CancellationToken.None);
        var d2 = await loader.GetOrFetchDiffAsync(Pr1, range, CancellationToken.None);

        d1.Should().BeSameAs(d2);
        review.GetDiffCallCount.Should().Be(1);
    }

    [Fact]
    public async Task IsPathInAnyCachedDiff_true_when_path_present_in_any_cached_diff_for_pr()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        // Default DiffFactory yields one file at "src/Foo.cs" — see FakePrDetailReviewService.
        var loader = MakeLoader(review);

        await loader.GetOrFetchDiffAsync(Pr1, new DiffRangeRequest("base1", "head1"), CancellationToken.None);

        loader.IsPathInAnyCachedDiff(Pr1, "src/Foo.cs").Should().BeTrue();
        loader.IsPathInAnyCachedDiff(Pr1, "src/Bar.cs").Should().BeFalse();
        loader.IsPathInAnyCachedDiff(new PrReference("o","r",999), "src/Foo.cs").Should().BeFalse(
            because: "path lookup is scoped to prRef so cross-PR contamination is blocked");
    }

    [Fact]
    public void TryGetCachedSnapshot_returns_null_when_no_snapshot_loaded()
    {
        var review = new FakePrDetailReviewService();
        var loader = MakeLoader(review);
        loader.TryGetCachedSnapshot(Pr1).Should().BeNull();
    }

    [Fact]
    public async Task TryGetCachedSnapshot_returns_snapshot_after_LoadAsync()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(5);
        var loader = MakeLoader(review);
        var loaded = await loader.LoadAsync(Pr1, CancellationToken.None);

        loader.TryGetCachedSnapshot(Pr1).Should().BeSameAs(loaded);
    }

    // #344 — RefreshAsync force-fresh cache bypass.

    [Fact]
    public async Task RefreshAsync_force_refetches_even_on_warm_cache_with_unchanged_head()
    {
        var calls = new List<string>();
        var review = new FakePrDetailReviewService(calls);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(1);
        var loader = MakeLoader(review);

        // Prime the cache (snapshot A) at head1.
        var first = await loader.LoadAsync(Pr1, CancellationToken.None);
        first.Should().NotBeNull();
        calls.Count(c => c == "GetPrDetail").Should().Be(1, "cold load fetches once");

        // Force refresh — head SHA is unchanged, so a plain reload would be a cache hit.
        var refreshed = await loader.RefreshAsync(Pr1, CancellationToken.None);

        refreshed.Should().NotBeNull();
        calls.Count(c => c == "GetPrDetail").Should().Be(2, "RefreshAsync re-fetches despite the warm cache");
        loader.TryGetCachedSnapshot(Pr1).Should().BeSameAs(refreshed, "the fresh snapshot replaced the cached one");
        refreshed.Should().NotBeSameAs(first, "force-fresh composes and commits a new snapshot");
    }

    [Fact]
    public async Task RefreshAsync_returns_null_when_detail_is_gone()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = null;
        var loader = MakeLoader(review);

        var result = await loader.RefreshAsync(Pr1, CancellationToken.None);

        result.Should().BeNull("GetPrDetail null => PR not found => endpoint maps 404");
    }

    [Fact]
    public async Task RefreshAsync_returns_uncached_when_generation_bumps_midflight()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(1);     // ≥1 commit so the clusterer runs
        var configStore = new FakeConfigStore();
        // Cluster() runs inside ComposeSnapshotAsync (after the detail fetch, before the cache
        // commit). Firing Changed there bumps the loader's generation via OnConfigChanged ->
        // InvalidateAll, so RefreshAsync's generation re-check returns the snapshot uncached.
        var clusterer = new InvalidatingClusterer(configStore);
        var loader = MakeLoader(review, clusterer: clusterer, configStore: configStore);

        var snapshot = await loader.RefreshAsync(Pr1, CancellationToken.None);

        snapshot.Should().NotBeNull("caller still gets fresh data");
        loader.TryGetCachedSnapshot(Pr1).Should().BeNull("a generation bump mid-flight leaves the result uncached");
    }

    // Fires the config store's Changed event from inside Cluster() to simulate a hot-reload
    // landing mid-compose; returns null (=> ClusteringQuality.Low), which is irrelevant to the test.
    private sealed class InvalidatingClusterer : IIterationClusteringStrategy
    {
        private readonly FakeConfigStore _configStore;
        public InvalidatingClusterer(FakeConfigStore configStore) => _configStore = configStore;
        public IReadOnlyList<IterationCluster>? Cluster(ClusteringInput input, IterationClusteringCoefficients coefficients)
        {
            _configStore.RaiseChanged();
            return null;
        }
    }
}

internal sealed class RecordingClusterer : IIterationClusteringStrategy
{
    private readonly List<string> _calls;
    private readonly IReadOnlyList<IterationCluster>? _result;

    public RecordingClusterer(List<string> calls, IReadOnlyList<IterationCluster>? result = null)
    {
        _calls = calls;
        _result = result;
    }

    public IReadOnlyList<IterationCluster>? Cluster(ClusteringInput input, IterationClusteringCoefficients coefficients)
    {
        _calls.Add("Cluster");
        return _result;
    }
}
