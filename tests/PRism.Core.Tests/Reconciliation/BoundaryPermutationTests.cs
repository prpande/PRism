using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class BoundaryPermutationTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task Row4IntersectRow6_TwoExactPlusFiveWhitespaceEquiv_ExactWins_AlternateCountOne()
    {
        // 2 exact-elsewhere + 5 whitespace-equiv-elsewhere; row 4 wins (exact tier priority).
        // AlternateMatchCount counts only the exact tier (2 - chosen = 1).
        var content = "line B\n  line B  \nline X\nline B\n  line B\nline B  \n  line B  \n  line B  \n";
        var result = await Run(content, originalLine: 5, anchored: "line B");
        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Moved, d.Status);
        Assert.Equal(1, d.AlternateMatchCount);
    }

    [Fact]
    public async Task Row2IntersectRow6_ExactAtOriginalPlusOneExactPlusFiveWhitespace_FreshAmbiguousAltCountOne()
    {
        var content = "line X\nline B\nline B\n  line B  \n  line B  \n  line B  \n  line B  \n  line B  \n";
        var result = await Run(content, originalLine: 2, anchored: "line B");
        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal(2, d.ResolvedLineNumber);
        Assert.Equal(1, d.AlternateMatchCount);
    }

    [Fact]
    public async Task ForcePushIntersectMultipleWhitespace_Stale()
    {
        // Anchored SHA unreachable + multiple whitespace-equiv matches → Stale per
        // spec/03 § 5 history-rewrite branch (no original-line tie-breaker is defensible).
        var content = "  line B  \n  line B  \n  line B  \n";
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { NewSha });

        var session = SessionWith(MakeDraft(originalLine: 5, anchored: "line B"));
        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.True(d.ForcePushFallbackTriggered);
    }

    [Fact]
    public async Task RenameAndContentUnchanged_StandardPathRunsAgainstNewPath()
    {
        var content = "line A\nline B\nline C\n";
        var fake = new FakeFileContentSource(
            files: new() { [("src/NewFoo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });

        var session = SessionWith(MakeDraft(originalLine: 2, anchored: "line B", path: "src/Foo.cs"));
        var pipeline = new DraftReconciliationPipeline();
        var renames = new Dictionary<string, string> { ["src/Foo.cs"] = "src/NewFoo.cs" };
        var result = await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None, renames);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal("src/NewFoo.cs", d.ResolvedFilePath);
    }

    private static async Task<ReconciliationResult> Run(string content, int originalLine, string anchored)
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(MakeDraft(originalLine, anchored));
        var pipeline = new DraftReconciliationPipeline();
        return await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None);
    }

    private static DraftComment MakeDraft(int originalLine, string anchored, string path = "src/Foo.cs")
        => new(
            Id: "d1",
            FilePath: path,
            LineNumber: originalLine,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: anchored,
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

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
