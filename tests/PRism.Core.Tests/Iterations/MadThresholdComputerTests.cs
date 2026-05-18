using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class MadThresholdComputerTests
{
    [Fact]
    public void Compute_with_bimodal_distribution_returns_threshold_between_modes()
    {
        var distances = new[] { 60.0, 65, 58, 62, 3600, 3500 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterThan(70).And.BeLessThan(3500);
    }

    [Fact]
    public void Compute_with_constant_distances_returns_threshold_above_all_values()
    {
        var distances = new[] { 100.0, 100, 100, 100 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterThan(100);
    }

    [Fact]
    public void Compute_with_single_element_returns_above_that_element()
    {
        var distances = new[] { 42.0 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterThan(42);
    }

    [Fact]
    public void Compute_with_empty_returns_double_max_value()
    {
        var threshold = MadThresholdComputer.Compute(Array.Empty<double>(), k: 3);
        threshold.Should().Be(double.MaxValue);
    }

    [Fact]
    public void Compute_with_mad_zero_and_single_outlier_returns_threshold_below_outlier()
    {
        // 2026-05-18 calibration: when MAD=0 (more-than-half of distances cluster at the
        // median), the new fallback returns the second-largest distance. This means the
        // helper IN ISOLATION will let the lone outlier register as a boundary —
        // documented here so callers don't assume the helper alone enforces a minimum
        // boundary gap. The strategy layer (WeightedDistanceClusteringStrategy) is what
        // applies MinimumBoundaryGapSeconds on top; the helper's contract is purely
        // statistical.
        //
        // Input [60, 60, 60, 65] — 60 dominates → median=60 → MAD=0 → secondLargest=60 →
        // threshold = max(median+1, 60) = 61. The outlier 65 would cross.
        var distances = new[] { 60.0, 60, 60, 65 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeLessThan(65,
            "outlier must cross — strategy-layer floor is what prevents over-segmentation on tight bursts");
        threshold.Should().BeGreaterThan(60,
            "median+1 still serves as the lower bound when secondLargest equals median");
    }

    [Fact]
    public void Compute_with_mad_zero_and_multiple_outliers_returns_threshold_below_smallest_outlier()
    {
        // Same MAD=0 case but with two clear outliers. secondLargest=70 (the smaller
        // outlier), so threshold sits between the cluster floor and the larger outlier —
        // only the strict-largest gap crosses, preserving the "one boundary at the most
        // extreme moment" intuition that drives PR #16's rebase-collapsed clustering.
        var distances = new[] { 60.0, 60, 60, 60, 70, 800 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterOrEqualTo(70,
            "secondLargest=70 should be the floor — the 70 outlier should NOT cross");
        threshold.Should().BeLessThan(800,
            "the 800 outlier MUST cross to form a single iteration boundary");
    }
}
