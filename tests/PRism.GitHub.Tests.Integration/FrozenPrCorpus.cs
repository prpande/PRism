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
    // SHAs / MergedAt / file lists / comment anchors are filled by Task 8's capture run.
    // The skeleton uses sentinel values that the capture script will overwrite — and the
    // `CorpusStalenessTest` will fail loudly if the dates are never populated.

    public static readonly FrozenPrEntry Pr1 = new(
        PrNumber: 1,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Low,
        ExpectedIterationRange: null,
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Single-iteration baseline");

    public static readonly FrozenPrEntry Pr16 = new(
        PrNumber: 16,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (1, 2),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Rebased-history committedDate collision");

    public static readonly FrozenPrEntry Pr19 = new(
        PrNumber: 19,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 3),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Multi-burst with review-fix tail");

    public static readonly FrozenPrEntry Pr22 = new(
        PrNumber: 22,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 2),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Overnight time-gap boundary");

    public static readonly FrozenPrEntry Pr28 = new(
        PrNumber: 28,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 2),
        ExpectedFiles: Array.Empty<string>(),
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
