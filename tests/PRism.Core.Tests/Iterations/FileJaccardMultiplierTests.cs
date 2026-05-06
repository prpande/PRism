using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class FileJaccardMultiplierTests
{
    private static readonly IterationClusteringCoefficients Defaults = new();

    private static ClusteringCommit Commit(string sha, params string[] files) =>
        new(sha, DateTimeOffset.UtcNow, "msg", 1, 0, files.Length == 0 ? null : files);

    private static ClusteringInput Input(params ClusteringCommit[] commits) =>
        new(commits, Array.Empty<ClusteringForcePush>(), Array.Empty<ClusteringReviewEvent>(),
            Array.Empty<ClusteringAuthorComment>());

    [Fact]
    public void Disjoint_files_returns_neutral_one()
    {
        var prev = Commit("a", "src/A.cs");
        var next = Commit("b", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Full_overlap_returns_minimum_zero_point_five()
    {
        var prev = Commit("a", "src/A.cs", "src/B.cs");
        var next = Commit("b", "src/A.cs", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(0.5, 0.001);
    }

    [Fact]
    public void Partial_overlap_lands_between_extremes()
    {
        var prev = Commit("a", "src/A.cs", "src/B.cs");
        var next = Commit("b", "src/B.cs", "src/C.cs");
        var m = new FileJaccardMultiplier();
        var result = m.For(prev, next, Input(prev, next), Defaults);
        result.Should().BeGreaterThan(0.5).And.BeLessThan(1.0);
    }

    [Fact]
    public void Empty_file_set_returns_neutral_one()
    {
        var prev = Commit("a");
        var next = Commit("b", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Unknown_changed_files_returns_neutral_one()
    {
        var prev = new ClusteringCommit("a", DateTimeOffset.UtcNow, "msg", 1, 0, ChangedFiles: null);
        var next = Commit("b", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(1.0, 0.001);
    }
}
