using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class RenameTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task RenamedFile_DraftFollowsRename()
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/NewFoo.cs", NewSha)] = "line A\nline B\nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var session = new ReviewSessionState(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new[] { draft },
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var renames = new Dictionary<string, string> { ["src/Foo.cs"] = "src/NewFoo.cs" };
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None, renames);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal("src/NewFoo.cs", d.ResolvedFilePath);
        Assert.Equal(2, d.ResolvedLineNumber);
    }
}
