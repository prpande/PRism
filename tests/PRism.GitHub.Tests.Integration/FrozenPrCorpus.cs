namespace PRism.GitHub.Tests.Integration;

public sealed record FrozenPrEntry(
    int PrNumber,
    string HeadSha,
    string BaseSha,                                       // historical merge-base captured at lock time; required by test 7b
    DateTimeOffset MergedAt,
    ClusteringQualityExpectation ExpectedQuality,
    (int Min, int Max)? ExpectedIterationRange,           // null when ExpectedQuality == Low
    IReadOnlyList<string> ExpectedFiles,                  // set-equality contract per spec § 5 row 7b
    IReadOnlyList<CommentAnchor> ExpectedCommentAnchors,  // subset contract per spec § 5 row 7c
    string ShapeCategory);                                // mirrors spec § 4 table for runbook reference

public sealed record CommentAnchor(string Path, int Line);

public enum ClusteringQualityExpectation { Ok, Low }

public static class FrozenPrCorpus
{
    // Captured 2026-05-18 via tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1
    // against the locked corpus PRs on prpande/PRism. Source-of-truth for what each integration
    // test asserts. To add a new corpus PR: see docs/contract-tests.md § "Adding a new test PR".

    public static readonly FrozenPrEntry Pr1 = new(
        PrNumber: 1,
        HeadSha: "b21b38b88d230a95e9545d5fc6882a5cf3913377",
        BaseSha: "9aacda22cc830fd70eda141bead36e1a3305b109",
        MergedAt: DateTimeOffset.Parse("2026-05-05T07:35:51Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind),
        // Calibration 2026-05-18: spec § 4 originally expected `Low` short-circuit. After the
        // calibration relaxed `PrDetailLoader.DetermineQuality` to short-circuit Low only when
        // `Commits.Count == 0`, 2 commits go through clustering and resolve to a single
        // iteration (which IS the correct answer — 2 adjacent commits introducing two related
        // YAML files is one unit of work). Reframed Ok+1.
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (1, 1),
        ExpectedFiles: new[]
        {
            ".github/workflows/claude-code-review.yml",
            ".github/workflows/claude.yml",
        },
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Single-iteration baseline");

    public static readonly FrozenPrEntry Pr16 = new(
        PrNumber: 16,
        HeadSha: "aa56128bc0545a38172f2fc5ebc8bb24da262512",
        BaseSha: "02d604524771e96893fb4281886db7e87aae3695",
        MergedAt: DateTimeOffset.Parse("2026-05-07T03:41:43Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind),
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (1, 2),
        ExpectedFiles: new[]
        {
            "PRism.Core/State/AppStateStore.cs",
            "docs/superpowers/plans/2026-05-07-appstatestore-windows-rename-retry.md",
            "docs/superpowers/plans/2026-05-07-flaky-spa-fallback-test-fix.md",
            "docs/superpowers/specs/2026-05-07-appstatestore-windows-rename-retry-design.md",
            "docs/superpowers/specs/2026-05-07-flaky-spa-fallback-test-fix-design.md",
            "tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs",
            "tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs",
        },
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Rebased-history committedDate collision");

    public static readonly FrozenPrEntry Pr19 = new(
        PrNumber: 19,
        HeadSha: "0dfad7c4b34f0881475a1b944db838e44efa54f1",
        BaseSha: "0f974cd8425295e4edf00482310d77411e417cc5",
        MergedAt: DateTimeOffset.Parse("2026-05-07T15:17:24Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind),
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 3),
        ExpectedFiles: new[]
        {
            "PRism.Core.Contracts/ActivePrPollSnapshot.cs",
            "PRism.Core.Contracts/ClusteringQuality.cs",
            "PRism.Core.Contracts/DiffDto.cs",
            "PRism.Core.Contracts/DiffRangeRequest.cs",
            "PRism.Core.Contracts/FileContentResult.cs",
            "PRism.Core.Contracts/IssueCommentDto.cs",
            "PRism.Core.Contracts/IterationDto.cs",
            "PRism.Core.Contracts/Pr.cs",
            "PRism.Core.Contracts/PrDetailDto.cs",
            "PRism.Core.Contracts/ReviewThreadDto.cs",
            "PRism.Core/IReviewService.cs",
            "PRism.Core/Iterations/IIterationClusteringStrategy.cs",
            "PRism.Core/Iterations/IterationClusteringCoefficients.cs",
            "PRism.Core/Iterations/WeightedDistanceClusteringStrategy.cs",
            "PRism.Core/State/AppState.cs",
            "PRism.Core/State/AppStateStore.cs",
            "PRism.Core/State/IAppStateStore.cs",
            "PRism.Core/State/StateResetFailedException.cs",
            "PRism.Core/State/UiPreferences.cs",
            "PRism.GitHub/GitHubGraphQLException.cs",
            "PRism.GitHub/GitHubReviewService.cs",
            "PRism.GitHub/HostUrlResolver.cs",
            "PRism.GitHub/RangeUnreachableException.cs",
            "PRism.GitHub/ServiceCollectionExtensions.cs",
            "tests/PRism.Core.Tests/Iterations/WeightedDistanceClusteringStrategyTests.cs",
            "tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs",
            "tests/PRism.GitHub.Tests/GitHubReviewServiceAuthHeaderTests.cs",
            "tests/PRism.GitHub.Tests/GitHubReviewServiceDiffTests.cs",
            "tests/PRism.GitHub.Tests/GitHubReviewServiceFileContentTests.cs",
            "tests/PRism.GitHub.Tests/GitHubReviewServicePollActivePrTests.cs",
            "tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs",
            "tests/PRism.GitHub.Tests/GitHubReviewServiceTimelineTests.cs",
            "tests/PRism.GitHub.Tests/HostUrlResolverTests.cs",
            "tests/PRism.GitHub.Tests/TestHelpers/GraphQLPlusRestHandler.cs",
            "tests/PRism.GitHub.Tests/TestHelpers/PaginatedFakeHandler.cs",
            "tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs",
        },
        ExpectedCommentAnchors: new[]
        {
            // Two anchored review comments at well-known production lines; the parser surfaces
            // any anchored review thread with these (FilePath, LineNumber) pairs. Subset contract
            // per spec § 5 row 7c — accidental new anchored comments do not break the assertion.
            new CommentAnchor("PRism.GitHub/GitHubReviewService.cs", 390),
            new CommentAnchor("PRism.GitHub/GitHubReviewService.cs", 548),
        },
        ShapeCategory: "Multi-burst with review-fix tail");

    public static readonly FrozenPrEntry Pr22 = new(
        PrNumber: 22,
        HeadSha: "06392c8f7cdc8d5dee3e913d4ecc2edf2c37a63b",
        BaseSha: "642397886ddd44207546b4aeea3124d1a3bb09e8",
        MergedAt: DateTimeOffset.Parse("2026-05-08T02:50:53Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind),
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 2),
        ExpectedFiles: new[]
        {
            "PRism.Core.Contracts/SubscribeRequest.cs",
            "PRism.Core/Events/ActivePrUpdated.cs",
            "PRism.Core/PRism.Core.csproj",
            "PRism.Core/PrDetail/ActivePrPoller.cs",
            "PRism.Core/PrDetail/ActivePrPollerState.cs",
            "PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs",
            "PRism.Core/ServiceCollectionExtensions.cs",
            "PRism.Web/Endpoints/EventsEndpoints.cs",
            "PRism.Web/Logging/SensitiveFieldScrubber.cs",
            "PRism.Web/Middleware/OriginCheckMiddleware.cs",
            "PRism.Web/Middleware/SessionTokenMiddleware.cs",
            "PRism.Web/Program.cs",
            "PRism.Web/Sse/SseChannel.cs",
            "docs/plans/2026-05-06-s3-pr-detail-read-deferrals.md",
            "docs/plans/2026-05-06-s3-pr-detail-read.md",
            "docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md",
            "docs/specs/2026-05-06-s3-pr-detail-read-design.md",
            "tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs",
            "tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryTests.cs",
            "tests/PRism.Core.Tests/PrDetail/FakePollerReviewService.cs",
            "tests/PRism.Core.Tests/PrDetail/FakeReviewEventBus.cs",
            "tests/PRism.Web.Tests/Endpoints/EventSourceCookieIntegrationTests.cs",
            "tests/PRism.Web.Tests/Endpoints/EventSourcePingTests.cs",
            "tests/PRism.Web.Tests/Endpoints/EventsEndpointsTests.cs",
            "tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs",
            "tests/PRism.Web.Tests/Endpoints/HtmlResponseCookieTests.cs",
            "tests/PRism.Web.Tests/Endpoints/RequestSizeLimitTests.cs",
            "tests/PRism.Web.Tests/Endpoints/SseChannelMultimapTests.cs",
            "tests/PRism.Web.Tests/Logging/SensitiveFieldScrubberTests.cs",
            "tests/PRism.Web.Tests/Middleware/OriginCheckMiddlewareTests.cs",
            "tests/PRism.Web.Tests/Middleware/SessionTokenMiddlewareTests.cs",
            "tests/PRism.Web.Tests/Middleware/SessionTokenProviderTests.cs",
            "tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs",
        },
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Overnight time-gap boundary");

    public static readonly FrozenPrEntry Pr28 = new(
        PrNumber: 28,
        HeadSha: "5cc50cbc96a001f8a5377c494f31a93c202d1dfa",
        BaseSha: "76606113ef3c64d9d87a9aaf917acae043fc6af2",
        MergedAt: DateTimeOffset.Parse("2026-05-08T18:57:18Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind),
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 2),
        ExpectedFiles: new[]
        {
            "docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md",
            "frontend/__tests__/DiffPane.test.tsx",
            "frontend/__tests__/MarkdownRenderer.sanitization.test.tsx",
            "frontend/__tests__/MermaidBlock.behavioral.test.tsx",
            "frontend/__tests__/WordDiffOverlay.test.tsx",
            "frontend/__tests__/setup-mermaid.ts",
            "frontend/package-lock.json",
            "frontend/package.json",
            "frontend/src/components/Markdown/MarkdownRenderer.tsx",
            "frontend/src/components/Markdown/MermaidBlock.tsx",
            "frontend/src/components/Markdown/shikiInstance.ts",
            "frontend/src/components/PrDetail/FilesTab/DiffPane.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx",
            "frontend/src/components/PrDetail/FilesTab/DiffPane/index.ts",
            "frontend/src/components/PrDetail/FilesTab/FilesTab.tsx",
            "frontend/vitest.config.ts",
        },
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Tight intra-cluster + late package-lock fix");

    public static IEnumerable<FrozenPrEntry> All()
    {
        yield return Pr1;
        yield return Pr16;
        yield return Pr19;
        yield return Pr22;
        yield return Pr28;
    }

    public static IEnumerable<object[]> AllAsTheoryData() =>
        All().Select(e => new object[] { e });
}
