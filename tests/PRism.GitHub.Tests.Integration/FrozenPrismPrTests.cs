using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

/// <summary>
/// Frozen-PR contract tests against the prpande/PRism corpus (spec § 5 + § 6.1).
/// Each test hits live GitHub through the production DI graph built by
/// <see cref="LiveGitHubFixture"/>. The corpus PRs are pinned by SHA so the
/// captured assertions remain stable across rebases and force-pushes.
/// </summary>
[Trait("Category", "Integration")]
[Collection(LiveGitHubCollection.Name)]
public class FrozenPrismPrTests
{
    private readonly LiveGitHubFixture _fixture;
    public FrozenPrismPrTests(LiveGitHubFixture fixture) => _fixture = fixture;

    private static PrReference Ref(FrozenPrEntry entry) => new("prpande", "PRism", entry.PrNumber);

    // 7a — iteration count per the corpus's expected range/equality contract.
    [Theory]
    [MemberData(nameof(FrozenPrCorpus.AllAsTheoryData), MemberType = typeof(FrozenPrCorpus))]
    public async Task Frozen_pr_returns_expected_iteration_count(FrozenPrEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var snap = await _fixture.Loader.LoadAsync(Ref(entry), CancellationToken.None);
        snap.Should().NotBeNull($"PR #{entry.PrNumber} must load — PrDetailLoader returned null");
        var dto = snap!.Detail;

        if (entry.ExpectedQuality == ClusteringQualityExpectation.Low)
        {
            dto.Iterations.Should().BeNull(
                $"PR #{entry.PrNumber} ({entry.ShapeCategory}) is expected to short-circuit Low");
        }
        else
        {
            dto.Iterations.Should().NotBeNull();
            var count = dto.Iterations!.Count;
            var (min, max) = entry.ExpectedIterationRange!.Value;
            if (min == max)
            {
                count.Should().Be(min,
                    $"PR #{entry.PrNumber} ({entry.ShapeCategory}) is expected at exactly {min}");
            }
            else
            {
                count.Should().BeInRange(min, max,
                    $"PR #{entry.PrNumber} ({entry.ShapeCategory}) is expected in [{min},{max}]");
            }
        }
    }

    // 7b — files list set-equality.
    [Theory]
    [MemberData(nameof(FrozenPrCorpus.AllAsTheoryData), MemberType = typeof(FrozenPrCorpus))]
    public async Task Frozen_pr_returns_expected_files_in_diff(FrozenPrEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var range = new DiffRangeRequest(BaseSha: entry.BaseSha, HeadSha: entry.HeadSha);
        var diff = await _fixture.Reader.GetDiffAsync(Ref(entry), range, CancellationToken.None);

        var actualFiles = diff.Files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToArray();
        var expectedFiles = entry.ExpectedFiles.OrderBy(p => p, StringComparer.Ordinal).ToArray();
        actualFiles.Should().Equal(expectedFiles,
            $"PR #{entry.PrNumber} files at SHA {entry.HeadSha} must match the captured corpus exactly");
    }

    // 7c — anchored on PR #19 only.
    [Fact]
    public async Task Frozen_pr_existing_comments_have_expected_anchors()
    {
        var pr19 = FrozenPrCorpus.Pr19;
        var snap = await _fixture.Loader.LoadAsync(Ref(pr19), CancellationToken.None);
        snap.Should().NotBeNull();
        var actualAnchors = snap!.Detail.ReviewComments
            .Select(t => new CommentAnchor(t.FilePath, t.LineNumber))
            .ToHashSet();

        // Subset assertion as a single set comparison so a failure surfaces EVERY missing
        // anchor in one diagnostic — the per-item foreach pattern would throw on the first
        // miss and hide the rest, which forces multiple triage round-trips.
        pr19.ExpectedCommentAnchors.Should().BeSubsetOf(actualAnchors,
            "If Frozen_pr_graphql_shape_unchanged is also failing, fix the fixture first; " +
            "this assertion runs against parsed shape.");
    }

    // 7f — clusteringQuality classification.
    [Theory]
    [MemberData(nameof(FrozenPrCorpus.AllAsTheoryData), MemberType = typeof(FrozenPrCorpus))]
    public async Task Frozen_pr_returns_clustering_quality_ok(FrozenPrEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        var snap = await _fixture.Loader.LoadAsync(Ref(entry), CancellationToken.None);
        snap.Should().NotBeNull();
        var expected = entry.ExpectedQuality == ClusteringQualityExpectation.Low
            ? ClusteringQuality.Low
            : ClusteringQuality.Ok;
        snap!.Detail.ClusteringQuality.Should().Be(expected,
            $"PR #{entry.PrNumber} ({entry.ShapeCategory}) expects {expected}");
    }

    // 7g — GraphQL shape-drift detector. Replays the EXACT production GraphQL query
    // (via the lifted internal `GitHubReviewService.PrDetailGraphQLQuery` constant)
    // against PR #19, strips content per the FixtureStripAllowlist, and diffs the
    // captured fixture against the live shape. Capture mode rewrites the fixture
    // locally and is hard-blocked in CI by `GhCliPat.EnsureCaptureModeNotInCi`.
    [Fact]
    public async Task Frozen_pr_graphql_shape_unchanged()
    {
        // CI write-protection layer 2: throws if PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 AND CI is set.
        GhCliPat.EnsureCaptureModeNotInCi();

        var pr19 = FrozenPrCorpus.Pr19;
        var liveResponse = await _fixture.LoadRawGraphQLResponseAsync(pr19.PrNumber);
        var stripped = FixtureStripAllowlist.Apply(liveResponse);
        var strippedJson = stripped!.ToJsonString();

        var fixturePath = FixturePathResolver.GetFixturePath("pr19-graphql-response.json");

        if (GhCliPat.IsCaptureModeEnabled())
        {
            File.WriteAllText(fixturePath, strippedJson);
            // The xunit test runner captures stdout per test — this surfaces in -v:detailed
            // output and in the .trx file. Operator runbook (Task 19) tells the user to
            // grep this line when checking that capture mode took effect.
            Console.WriteLine($"Captured fixture for PR #19 -> {fixturePath}. Re-run without the env var to assert.");
            return;  // capture-mode runs always pass; assert mode is a separate invocation.
        }

        File.Exists(fixturePath).Should().BeTrue(
            $"Fixture must exist; run with PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 once locally to generate. Path: {fixturePath}");

        using var expectedDoc = JsonDocument.Parse(File.ReadAllText(fixturePath));
        using var actualDoc = JsonDocument.Parse(strippedJson);
        var diffs = GraphQLShapeDiff.Diff(expectedDoc.RootElement, actualDoc.RootElement);

        diffs.Should().BeEmpty(
            "GraphQL shape drift detected — see structured diff:\n" + string.Join("\n", diffs));
    }

    // 7h — PR #16 must not fabricate iterations despite collapsed committedDate.
    [Fact]
    public async Task Frozen_pr_handles_rebased_committedDate_collision()
    {
        var pr16 = FrozenPrCorpus.Pr16;
        var snap = await _fixture.Loader.LoadAsync(Ref(pr16), CancellationToken.None);
        snap.Should().NotBeNull();
        var dto = snap!.Detail;
        dto.Iterations.Should().NotBeNull();
        dto.Iterations!.Count.Should().BeInRange(1, 2,
            "PR #16's 9 commits share identical committedDate; algorithm must degrade gracefully");
        dto.ClusteringQuality.Should().Be(ClusteringQuality.Ok,
            "PR #16 is healthy multi-commit, not degenerate");
    }
}
