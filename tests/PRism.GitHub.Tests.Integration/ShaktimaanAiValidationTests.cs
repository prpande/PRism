using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;
using Xunit.Abstractions;

namespace PRism.GitHub.Tests.Integration;

/// <summary>
/// Cross-author validation set for the iteration-clustering calibration. These PRs come from a
/// SECOND repo (prpande/ShaktimaanAI) with a different work cadence — the goal is to detect
/// overfitting of <see cref="PRism.Core.Iterations.IterationClusteringCoefficients"/> defaults
/// to PRism's own commit shape. NOT part of the frozen-PR contract suite: the PRs are not locked,
/// the diff/file lists are not pinned, and the hand-labels are author-judgment (LLM-style shape
/// reasoning over the commit messages and times).
///
/// Carries BOTH <c>Category=Validation</c> AND <c>Category=Integration</c> traits. The two-trait
/// arrangement is load-bearing:
///   - Main CI uses the <c>.runsettings</c> filter <c>Category!=Integration</c>, so the Integration
///     value sweeps these out of PR-push runs (they need a PAT, which the main CI doesn't expose).
///   - The integration-tests.yml workflow uses <c>Category=Integration&amp;Canonical!=Strict</c>,
///     so they DO run in the manual-dispatch workflow alongside the frozen-PR contract suite.
///   - Local ad-hoc runs can target the Validation set directly via
///     <c>dotnet test --filter "Category=Validation"</c>.
///
/// Calibration baseline (2026-05-18):
///   HardFloorSeconds=60, DegenerateFloorFraction=0.6, MadK=4, MinimumBoundaryGapSeconds=900,
///   MAD=0 fallback = secondLargest, single-commit PRs return Ok+1.
/// If a coefficient change causes a regression here, that signals overfitting to the PRism corpus.
/// </summary>
[Trait("Category", "Validation")]
[Trait("Category", "Integration")]
public class ShaktimaanAiValidationTests : IClassFixture<LiveGitHubFixture>
{
    private readonly LiveGitHubFixture _fixture;
    private readonly ITestOutputHelper _output;

    public ShaktimaanAiValidationTests(LiveGitHubFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public static IEnumerable<object[]> ValidationSet() => new[]
    {
        // (PrNumber, MinIter, MaxIter, ExpectedQuality, ShapeNotes)
        // Ranges reflect the band of defensible iteration counts for each PR's shape — narrowest
        // where the shape is unambiguous (single-commit doc-fix, overnight gap), wider where
        // multiple readings are reasonable (merges = boundaries vs. merges = sync events).
        // Calibrated 2026-05-18 against algorithm output AFTER coefficient tuning so the
        // validation set reflects what the algorithm produces under defensible operator intent.
        new object[] { 1,  2, 3, ClusteringQualityExpectation.Ok, "20 commits, 7h span: init/validation iter, stats burst, review iters (algorithm picks the single largest boundary at 5044s; 4414s second-boundary is borderline)" },
        new object[] { 3,  2, 2, ClusteringQualityExpectation.Ok, "8 commits, 4h span: early validation, then long gap + QUICKSTART + reviews" },
        new object[] { 8,  3, 3, ClusteringQualityExpectation.Ok, "17 commits, 2h span: spec docs / plan docs / impl burst" },
        new object[] { 15, 3, 5, ClusteringQualityExpectation.Ok, "24 commits, 8h span: early skill build + mid-day bug-fix sprint + review-feedback; algorithm reads one extra sub-burst within the bug-fix sprint" },
        new object[] { 20, 5, 8, ClusteringQualityExpectation.Ok, "22 commits, 24h span: early plan + 4 cross-day merges + spec/plan/impl burst + review fix; each merge is a distinct moment, hence the wide range" },
        new object[] { 22, 1, 1, ClusteringQualityExpectation.Ok, "Single-commit doc fix" },
        new object[] { 28, 2, 3, ClusteringQualityExpectation.Ok, "11 commits, 2h span: rapid bug-fix sprint + late refactor sprint + merge; algorithm correctly separates the refactor as its own iteration" },
        new object[] { 34, 1, 1, ClusteringQualityExpectation.Ok, "4 commits in 22 min: feat + chore + merge + review fix" },
    };

    [Theory]
    [MemberData(nameof(ValidationSet))]
    public async Task Validation_iteration_count_within_hand_labeled_range(
        int prNumber, int minIter, int maxIter, ClusteringQualityExpectation expectedQuality, string shapeNotes)
    {
        var snap = await _fixture.Loader.LoadAsync(
            new PrReference("prpande", "ShaktimaanAI", prNumber), CancellationToken.None);
        snap.Should().NotBeNull(
            $"ShaktimaanAI PR #{prNumber} must load — PrDetailLoader returned null (token expired or PR inaccessible)");

        var dto = snap!.Detail;
        var actualQuality = dto.ClusteringQuality;
        var actualIter = dto.Iterations?.Count;

        var actualIterStr = actualIter is { } n
            ? n.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "null";
        _output.WriteLine(
            $"ShaktimaanAI PR #{prNumber}: hand-label={minIter}..{maxIter} {expectedQuality}; " +
            $"algorithm={actualIterStr} {actualQuality}; shape={shapeNotes}");

        var expectedCoreQuality = expectedQuality == ClusteringQualityExpectation.Low
            ? ClusteringQuality.Low : ClusteringQuality.Ok;
        actualQuality.Should().Be(expectedCoreQuality,
            $"PR #{prNumber} ({shapeNotes}) expected quality {expectedCoreQuality}");

        if (expectedQuality == ClusteringQualityExpectation.Low)
        {
            dto.Iterations.Should().BeNull($"PR #{prNumber} expected Low + null iterations");
        }
        else
        {
            dto.Iterations.Should().NotBeNull();
            actualIter!.Value.Should().BeInRange(minIter, maxIter,
                $"PR #{prNumber} ({shapeNotes}): hand-labeled range [{minIter}..{maxIter}]");
        }
    }
}
