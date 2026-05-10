using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class WhitespaceTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task CrlfToLfFlip_MatchesViaWhitespaceEquivalent()
    {
        // Anchored content retains its trailing CR; new content has LF only.
        // SplitLines TrimEnd('\r') normalizes the FILE's split lines but NOT the anchored
        // content. Match goes through the WhitespaceEquiv path: Normalize("line B") ==
        // Normalize("line B\r") == "lineB" (the all-whitespace strip in LineMatching.Normalize
        // removes the \r). Result is Status=Draft at the original line.
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = "line A\nline B\nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B\r",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal(2, d.ResolvedLineNumber);
    }

    [Fact]
    public async Task WhitespaceEquivInAllowlistedExt_TreatedAsMatch()
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = "line A\n  line B  \nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = MakeDraft(path: "src/Foo.cs", anchored: "line B");
        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
    }

    [Fact]
    public async Task TrailingNewline_DoesNotProduceSpuriousMatch_AtPhantomLine()
    {
        // SplitLines drops exactly one trailing empty element when content ends with \n
        // (POSIX text-file convention). Without that trim, a 3-line file with trailing \n
        // would be split into 4 entries and the phantom 4th line ("") would whitespace-equiv
        // match an empty anchored content, producing a spurious end-of-file match.
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = "line A\nline B\nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 4,                      // phantom (file has 3 lines after trim)
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "",            // empty anchor (degenerate but possible)
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        // Without the trim: the phantom line 4 would whitespace-equiv match empty anchored
        // content → Row 5 (Fresh) at line 4. With the trim: no candidate exists → Stale.
        Assert.Equal(DraftStatus.Stale, d.Status);
    }

    [Fact]
    public async Task WhitespaceEquivInPyExt_NotAllowlisted_FallsBackToExactOnly_Stale()
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/foo.py", NewSha)] = "line A\n  line B  \nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = MakeDraft(path: "src/foo.py", anchored: "line B");
        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
    }

    private static DraftComment MakeDraft(string path, string anchored)
        => new(
            Id: "d1",
            FilePath: path,
            LineNumber: 2,
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
