using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

// Spec § 6.1 + § 6.4 + Q5. PrDetailLoader is a concrete class — there is no
// IPrDetailLoader interface. Tests substitute IReviewService directly via constructor
// injection (the loader's only meaningful collaborator that varies between tests).
public class PrDetailLoaderTests
{
    private static readonly PrReference Pr1 = new("owner", "repo", 1);

    private static PrDetailDto MakeDetail(string headSha = "head1", string baseSha = "base1") =>
        new(
            Pr: new Pr(
                Reference: Pr1,
                Title: "Test PR",
                Body: "body",
                Author: "alice",
                State: "OPEN",
                HeadSha: headSha,
                BaseSha: baseSha,
                HeadBranch: "feat/x",
                BaseBranch: "main",
                Mergeability: "MERGEABLE",
                CiSummary: "passing",
                IsMerged: false,
                IsClosed: false,
                OpenedAt: DateTimeOffset.UtcNow),
            ClusteringQuality: ClusteringQuality.Ok,                  // overwritten by loader
            Iterations: null,                                          // overwritten by loader
            Commits: Array.Empty<CommitDto>(),                         // overwritten by loader
            RootComments: Array.Empty<IssueCommentDto>(),
            ReviewComments: Array.Empty<ReviewThreadDto>(),
            TimelineCapHit: false);

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
        FakeConfigStore? configStore = null) =>
        new(
            review,
            clusterer ?? new RecordingClusterer(new List<string>()),
            new IterationClusteringCoefficients(),
            configStore ?? new FakeConfigStore());

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

    // Q5 — ClusteringQuality determination tests.

    [Fact]
    public async Task LoadAsync_returns_ClusteringQuality_Low_when_timeline_has_one_commit()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultDetailResponse = MakeDetail();
        review.DefaultTimelineResponse = MakeTimeline(1);
        var loader = MakeLoader(review);

        var snapshot = await loader.LoadAsync(Pr1, CancellationToken.None);

        snapshot.Should().NotBeNull();
        snapshot!.Detail.ClusteringQuality.Should().Be(ClusteringQuality.Low);
        snapshot.Detail.Iterations.Should().BeNull();
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
