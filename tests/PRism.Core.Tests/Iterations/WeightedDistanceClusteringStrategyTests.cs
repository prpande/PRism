using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class WeightedDistanceClusteringStrategyTests
{
    private static readonly IterationClusteringCoefficients Defaults = new();

    private static IIterationClusteringStrategy NewStrategy() =>
        new WeightedDistanceClusteringStrategy(new IDistanceMultiplier[]
        {
            new FileJaccardMultiplier(),
            new ForcePushMultiplier()
        });

    private static ClusteringCommit Commit(string sha, DateTimeOffset at, params string[] files) =>
        new(sha, at, "msg", 1, 0, files.Length == 0 ? Array.Empty<string>() : files);

    private static ClusteringInput Input(params ClusteringCommit[] commits) =>
        new(commits, Array.Empty<ClusteringForcePush>(), Array.Empty<ClusteringReviewEvent>(),
            Array.Empty<ClusteringAuthorComment>());

    [Fact]
    public void Empty_commits_returns_no_clusters()
    {
        NewStrategy().Cluster(Input(), Defaults).Should().BeEmpty();
    }

    [Fact]
    public void Single_commit_returns_one_cluster()
    {
        var c = Commit("a", DateTimeOffset.UtcNow);
        var clusters = NewStrategy().Cluster(Input(c), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().ContainSingle().Which.Should().Be("a");
    }

    [Fact]
    public void Tight_amend_cluster_collapses_to_single_iteration()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 5)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 30), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
    }

    [Fact]
    public void Two_distinct_groups_with_long_gap_split_into_two_iterations()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                        "src/A.cs"),
            Commit("c1", t0.AddSeconds(60),         "src/A.cs"),
            Commit("c2", t0.AddHours(4),            "src/B.cs"),
            Commit("c3", t0.AddHours(4).AddSeconds(60), "src/B.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(2);
        clusters[0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" });
        clusters[1].CommitShas.Should().BeEquivalentTo(new[] { "c2", "c3" });
    }

    [Fact]
    public void Hard_floor_clamps_subsecond_gaps_to_floor()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                            "src/A.cs"),
            Commit("c1", t0.AddMilliseconds(50),        "src/A.cs"),
            Commit("c2", t0.AddMilliseconds(100),       "src/A.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
    }

    [Fact]
    public void Sort_uses_committed_date_not_authored_date()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c1", t0.AddSeconds(60), "src/A.cs"),
            Commit("c0", t0,                "src/A.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" }, opts => opts.WithStrictOrdering());
    }

    [Fact]
    public void Negative_delta_clamps_to_zero()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                        "src/A.cs"),
            Commit("c1", t0.AddSeconds(-1),         "src/A.cs"),
            Commit("c2", t0.AddSeconds(60),         "src/A.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().BeEquivalentTo(new[] { "c1", "c0", "c2" }, opts => opts.WithStrictOrdering());
    }

    [Fact]
    public void Natural_gaps_just_above_floor_should_not_trigger_degenerate_fallback()
    {
        // 8 commits, 601s apart, full file overlap -> FileJaccardMultiplier = 0.5
        // -> weighted gap = 601 * 0.5 = 300.5s, just above the 300s floor (passes Math.Clamp through).
        // The degenerate detector must NOT count these as floor-clamped: they were not clamped.
        // MAD path: all distances equal -> MAD=0 -> threshold = median+1 = 301.5; no edge exceeds -> single cluster.
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 8)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 601), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
    }

    [Fact]
    public void Degenerate_floor_clamped_majority_falls_back_to_one_per_commit()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 8)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 10), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(8);
    }

    [Fact]
    public void Degenerate_fallback_above_max_tabs_returns_single_inconclusive_cluster()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 25)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 10), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().HaveCount(25);
    }

    [Fact]
    public void Gap_wider_than_hard_ceiling_is_clamped_and_still_splits()
    {
        // Spec § 11.2 requires a hard-ceiling case: gaps wider than HardCeilingSeconds (3 days)
        // must clamp to the ceiling so the weighted distance doesn't grow unbounded, while still
        // exceeding the MAD threshold and producing a cluster boundary.
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                              "src/A.cs"),
            Commit("c1", t0.AddSeconds(60),               "src/A.cs"),
            Commit("c2", t0.AddDays(5),                   "src/B.cs"),  // > 3-day ceiling
            Commit("c3", t0.AddDays(5).AddSeconds(60),    "src/B.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(2);
        clusters[0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" });
        clusters[1].CommitShas.Should().BeEquivalentTo(new[] { "c2", "c3" });
    }

    [Fact]
    public void Lowering_mad_k_flips_borderline_gap_into_a_split()
    {
        // Spec § 11.2 requires a "coefficient changes flip clustering decisions deterministically" case.
        // 6 commits with one borderline gap between c2 and c3. With MadK=3 the gap stays inside the
        // band → 1 cluster. With MadK=1 the gap exceeds median + 1*MAD → 2 clusters.
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                       "src/A.cs"),
            Commit("c1", t0.AddSeconds(60),        "src/A.cs"),
            Commit("c2", t0.AddSeconds(120),       "src/A.cs"),
            Commit("c3", t0.AddSeconds(900),       "src/B.cs"),
            Commit("c4", t0.AddSeconds(960),       "src/B.cs"),
            Commit("c5", t0.AddSeconds(1020),      "src/B.cs"),
        };
        var withMadK3 = NewStrategy().Cluster(Input(commits), Defaults with { MadK = 3 });
        var withMadK1 = NewStrategy().Cluster(Input(commits), Defaults with { MadK = 1 });

        withMadK1.Count.Should().BeGreaterThan(withMadK3.Count,
            because: "lowering MadK tightens the threshold, so a borderline gap should produce more cluster boundaries");
    }

    [Fact]
    public void Cluster_throws_when_floor_exceeds_ceiling()
    {
        var commits = new[] { Commit("c0", DateTimeOffset.UtcNow, "src/A.cs") };
        var bad = Defaults with { HardFloorSeconds = 1000, HardCeilingSeconds = 100 };
        var act = () => NewStrategy().Cluster(Input(commits), bad);
        act.Should().Throw<ArgumentException>().WithMessage("*HardFloorSeconds*");
    }

    [Fact]
    public void Cluster_throws_when_mad_k_is_zero_or_negative()
    {
        var commits = new[] { Commit("c0", DateTimeOffset.UtcNow, "src/A.cs") };
        var act = () => NewStrategy().Cluster(Input(commits), Defaults with { MadK = 0 });
        act.Should().Throw<ArgumentException>().WithMessage("*MadK*");
    }

    [Fact]
    public void Cluster_throws_when_file_jaccard_weight_would_zero_the_multiplier()
    {
        var commits = new[] { Commit("c0", DateTimeOffset.UtcNow, "src/A.cs") };
        var act = () => NewStrategy().Cluster(Input(commits), Defaults with { FileJaccardWeight = 1.0 });
        act.Should().Throw<ArgumentException>().WithMessage("*FileJaccardWeight*");
    }
}
