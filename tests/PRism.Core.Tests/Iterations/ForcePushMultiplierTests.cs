using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class ForcePushMultiplierTests
{
    private static readonly IterationClusteringCoefficients Defaults = new();

    private static ClusteringCommit Commit(string sha, DateTimeOffset at) =>
        new(sha, at, "msg", 1, 0, Array.Empty<string>());

    private static ClusteringInput Input(IEnumerable<ClusteringCommit> commits, IEnumerable<ClusteringForcePush> forcePushes) =>
        new(commits.ToArray(), forcePushes.ToArray(), Array.Empty<ClusteringReviewEvent>(), Array.Empty<ClusteringAuthorComment>());

    [Fact]
    public void No_force_push_returns_neutral_one()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(60));
        var input = Input(new[] { prev, next }, Array.Empty<ClusteringForcePush>());
        new ForcePushMultiplier().For(prev, next, input, Defaults).Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Force_push_within_short_gap_returns_neutral_one()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(30));
        var fp = new ClusteringForcePush("a", "b", t0.AddSeconds(15));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Force_push_after_long_gap_returns_one_point_five()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(1200));
        var fp = new ClusteringForcePush("a", "b", t0.AddSeconds(1000));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }

    [Fact]
    public void Force_push_with_null_shas_positions_by_occurredAt_in_window()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(2000));
        var fp = new ClusteringForcePush(null, null, t0.AddSeconds(1500));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }

    [Fact]
    public void Force_push_with_null_shas_clock_skewed_before_prev_does_not_apply()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(2000));
        var fp = new ClusteringForcePush(null, null, t0.AddSeconds(-10));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Multiple_force_pushes_in_window_apply_at_most_once()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(1200));
        var fp1 = new ClusteringForcePush("a", "x", t0.AddSeconds(500));
        var fp2 = new ClusteringForcePush("x", "b", t0.AddSeconds(900));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp1, fp2 }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }
}
