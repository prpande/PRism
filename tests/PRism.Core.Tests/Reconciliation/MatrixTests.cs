using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class MatrixTests
{
    // 40-char hex SHAs throughout reconciliation tests. The unit tests use
    // FakeFileContentSource (no validation), so short placeholders would compile and pass —
    // but full SHAs (a) match the shape endpoint integration tests will see, (b) prevent
    // accidental short-SHA propagation if a fixture moves to integration scope, and
    // (c) match the endpoint validation regex `^[0-9a-f]{40}$`.
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    public static IEnumerable<object?[]> MatrixRows()
    {
        // Row 1: Exact match at original line, no others → Fresh (silent re-anchor)
        yield return new object?[]
        {
            "Row1_ExactAtOriginal_NoOthers_Fresh",
            "line A\nline B\nline C\n",
            2,
            "line B",
            DraftStatus.Draft, (int?)2, 0, null!
        };

        // Row 2: Exact match at original + N others → Fresh-but-ambiguous
        yield return new object?[]
        {
            "Row2_ExactAtOriginal_PlusOthers_FreshAmbiguous",
            "line B\nline B\nline C\n",
            1,
            "line B",
            DraftStatus.Draft, (int?)1, 1, null
        };

        // Row 3: Exact elsewhere only (single) → Moved
        yield return new object?[]
        {
            "Row3_ExactElsewhere_Single_Moved",
            "line A\nline X\nline B\n",
            2,
            "line B",
            DraftStatus.Moved, (int?)3, 0, null
        };

        // Row 4: Multiple exact elsewhere, none at original → Moved-ambiguous (closest wins)
        yield return new object?[]
        {
            "Row4_MultipleExactElsewhere_NoneAtOriginal_MovedAmbiguous",
            "line B\nline X\nline B\n",
            2,
            "line B",
            DraftStatus.Moved, (int?)1, 1, null
        };

        // Row 5: No exact, single whitespace-equivalent → Fresh
        yield return new object?[]
        {
            "Row5_NoExact_SingleWhitespaceEquiv_Fresh",
            "line A\n  line B  \nline C\n",
            2,
            "line B",
            DraftStatus.Draft, (int?)2, 0, null!
        };

        // Row 6: No exact, multiple whitespace-equivalent → Moved-ambiguous (closest wins).
        // Plan deviation: plan expected ResolvedLine=3, but candidates [1, 3] are equidistant
        // from originalLine=2 — Row 4 (same shape, exact tier) expects 1, so Row 6 must too
        // for a single deterministic tie-break (lower line wins). See deferrals sidecar.
        yield return new object?[]
        {
            "Row6_NoExact_MultipleWhitespaceEquiv_MovedAmbiguous",
            "  line B\nline X\nline B  \n",
            2,
            "line B",
            DraftStatus.Moved, (int?)1, 1, (StaleReason?)null
        };

        // Row 7: No match → Stale
        yield return new object?[]
        {
            "Row7_NoMatch_Stale",
            "line X\nline Y\nline Z\n",
            2,
            "line B",
            DraftStatus.Stale, (int?)null, 0, (StaleReason?)StaleReason.NoMatch
        };
    }

    [Theory]
    [MemberData(nameof(MatrixRows))]
    public async Task MatrixRow(
        string name,
        string newFileContent,
        int originalLine,
        string anchoredContent,
        DraftStatus expectedStatus,
        int? expectedResolvedLine,
        int expectedAlternates,
        StaleReason? expectedStaleReason)
    {
        _ = name;

        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: originalLine,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: anchoredContent,
            BodyMarkdown: "comment body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var session = SessionWith(draft);

        var fake = new FakeFileContentSource(
            files: new Dictionary<(string, string), string>
            {
                [("src/Foo.cs", NewSha)] = newFileContent
            },
            reachableShas: new HashSet<string> { OldSha, NewSha });

        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var reconciled = Assert.Single(result.Drafts);
        Assert.Equal(expectedStatus, reconciled.Status);
        Assert.Equal(expectedResolvedLine, reconciled.ResolvedLineNumber);
        Assert.Equal(expectedAlternates, reconciled.AlternateMatchCount);
        Assert.Equal(expectedStaleReason, reconciled.StaleReason);
    }

    private static ReviewSessionState SessionWith(params DraftComment[] drafts)
        => new(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: drafts,
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
