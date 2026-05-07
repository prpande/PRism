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
    public void Empty_commits_returns_empty_array()
    {
        // Defensive: PrDetailLoader is the canonical pre-check (spec § 6.4 routes ≤1-commit
        // PRs to ClusteringQuality:Low before calling Cluster). Empty input from an upstream
        // bug should still produce a stable, non-null, no-iterations result rather than
        // surfacing as a NullReferenceException downstream.
        NewStrategy().Cluster(Input(), Defaults).Should().NotBeNull().And.BeEmpty();
    }

    [Fact]
    public void Single_commit_returns_one_cluster()
    {
        // Defensive: see Empty_commits_returns_empty_array. PrDetailLoader handles the
        // 1-commit case via ClusteringQuality:Low; this test pins the strategy's fallback
        // shape if the loader's check is bypassed.
        var c = Commit("a", DateTimeOffset.UtcNow);
        var clusters = NewStrategy().Cluster(Input(c), Defaults);
        clusters.Should().NotBeNull().And.HaveCount(1);
        clusters![0].CommitShas.Should().ContainSingle().Which.Should().Be("a");
    }

    [Fact]
    public void Tight_amend_cluster_collapses_to_single_iteration()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 5)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 30), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().NotBeNull().And.HaveCount(1);
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
        clusters.Should().NotBeNull().And.HaveCount(2);
        clusters![0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" });
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
        clusters.Should().NotBeNull().And.HaveCount(1);
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
        clusters.Should().NotBeNull().And.HaveCount(1);
        clusters![0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" }, opts => opts.WithStrictOrdering());
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
        clusters.Should().NotBeNull().And.HaveCount(1);
        clusters![0].CommitShas.Should().BeEquivalentTo(new[] { "c1", "c0", "c2" }, opts => opts.WithStrictOrdering());
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
        clusters.Should().NotBeNull().And.HaveCount(1);
    }

    [Fact]
    public void Degenerate_floor_clamped_majority_returns_null()
    {
        // Spec § 6.4: when > DegenerateFloorFraction of weighted distances are clamped to the
        // hard floor AND we have ≥ MadK*2 edges, the strategy returns null. PrDetailLoader
        // translates this to ClusteringQuality:Low and the frontend renders CommitMultiSelectPicker.
        // Replaces the prior tab-per-commit / single-tab materialized fallback (Q5 redesign).
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 8)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 10), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().BeNull();
    }

    [Fact]
    public void Degenerate_returns_null_regardless_of_commit_count()
    {
        // Pre-Q5 the behavior diverged at MaxFallbackTabs (≤20 commits → tab-per-commit;
        // >20 → single inconclusive cluster). Post-Q5: null in all degenerate cases — the
        // commit-count branch and MaxFallbackTabs both go away.
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 25)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 10), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().BeNull();
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
        clusters.Should().NotBeNull().And.HaveCount(2);
        clusters![0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" });
        clusters[1].CommitShas.Should().BeEquivalentTo(new[] { "c2", "c3" });
    }

    [Fact]
    public void Lowering_mad_k_flips_clustering_via_degenerate_gate()
    {
        // Spec § 11.2 requires a "coefficient changes flip clustering decisions deterministically" case.
        // Mechanism: 6 commits → 5 weighted edges; tight 60s gaps (full overlap → multiplier 0.5)
        // clamp to the 300s floor, but the c2→c3 cross-file 780s gap passes through. Resulting
        // weighted = [300, 300, 780, 300, 300] (4 floor-clamped of 5).
        // With MadK=3, the degenerate gate `weighted.Length >= MadK*2` is 5 >= 6 → false → MAD path
        //              runs (median=300, MAD=0 → threshold=301), only the 780 edge exceeds → 2 clusters.
        // With MadK=1, the gate is 5 >= 2 → true, and floor-clamped fraction 4/5 > 0.5 → degenerate
        //              fallback fires → strategy returns null (post-Q5: PrDetailLoader emits
        //              ClusteringQuality:Low; frontend renders CommitMultiSelectPicker).
        // Both arms test the spec requirement: changing a coefficient deterministically flips the
        // decision. The mechanism here is the degenerate gate flipping, NOT the MAD threshold itself.
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

        withMadK3.Should().NotBeNull(because: "MadK=3 fails the degenerate gate, so the MAD path runs");
        withMadK3!.Should().HaveCount(2, because: "MAD path: median=300, MAD=0 → threshold=301, only the 780s edge exceeds");
        withMadK1.Should().BeNull(because: "MadK=1 lets the degenerate gate fire (5 ≥ 2) on a floor-heavy weighted array; strategy returns null for ClusteringQuality:Low");
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
