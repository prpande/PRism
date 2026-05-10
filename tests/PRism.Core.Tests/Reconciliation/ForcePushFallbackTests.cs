using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class ForcePushFallbackTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task SingleExactMatch_Moved_WithFlagSet()
    {
        var fake = MakeFake("line A\nline B\nline C\n");
        var session = SessionWith(MakeDraft());
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Moved, d.Status);
        Assert.True(d.ForcePushFallbackTriggered);
        Assert.Equal(2, d.ResolvedLineNumber);
    }

    [Fact]
    public async Task MultipleMatches_Stale()
    {
        var fake = MakeFake("line B\nline B\nline B\n");
        var session = SessionWith(MakeDraft());
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.ForcePushAmbiguous, d.StaleReason);
        Assert.True(d.ForcePushFallbackTriggered);
    }

    [Fact]
    public async Task NoMatch_Stale()
    {
        var fake = MakeFake("line X\nline Y\n");
        var session = SessionWith(MakeDraft());
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.NoMatch, d.StaleReason);
        Assert.True(d.ForcePushFallbackTriggered);
    }

    private static FakeFileContentSource MakeFake(string content)
        => new(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { NewSha });   // OldSha NOT reachable → fallback fires

    private static DraftComment MakeDraft()
        => new(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
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
