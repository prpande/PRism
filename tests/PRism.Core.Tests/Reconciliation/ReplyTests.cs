using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class ReplyTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task Reply_PassesThroughUnchanged_PR2Scope()
    {
        // PR2 scope: replies pass-through. The ParentThreadDeleted check is added in PR3
        // when the endpoint passes existingThreadIds to the pipeline. Keeping this trivial
        // contract test prevents a silent regression of the pass-through behavior.
        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });

        var reply = new DraftReply(
            Id: "r1",
            ParentThreadId: "PRRT_xxx",
            ReplyCommentId: null,
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var session = new ReviewSessionState(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new[] { reply },
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var r = Assert.Single(result.Replies);
        Assert.Equal(DraftStatus.Draft, r.Status);
    }
}
