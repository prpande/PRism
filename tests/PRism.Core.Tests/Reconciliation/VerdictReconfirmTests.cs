using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class VerdictReconfirmTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";
    private const string SameSha = "000000000000000000000000000000000000000a";

    [Fact]
    public async Task VerdictSetAndHeadShifted_NeedsReconfirm()
    {
        var session = SessionWith(OldSha, verdict: DraftVerdict.Approve);
        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.NeedsReconfirm, result.VerdictOutcome);
    }

    [Fact]
    public async Task VerdictSetAndHeadUnchanged_Unchanged()
    {
        var session = SessionWith(SameSha, verdict: DraftVerdict.Approve);
        var fake = new FakeFileContentSource(reachableShas: new() { SameSha });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, SameSha, fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.Unchanged, result.VerdictOutcome);
    }

    [Fact]
    public async Task VerdictSetButLastViewedHeadShaNull_Unchanged()
    {
        // Symmetric to the override head-shift check at the top of ReconcileAsync:
        // a session with LastViewedHeadSha == null is not a head shift even if a verdict
        // is pre-set. Currently unreachable through normal user flow (verdict requires
        // viewing the PR), but the symmetry prevents the asymmetric pattern from becoming
        // a latent trap when PR3 wires the endpoint.
        var session = SessionWith(lastViewedHeadSha: null!, verdict: DraftVerdict.Approve);
        var fake = new FakeFileContentSource(reachableShas: new() { NewSha });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.Unchanged, result.VerdictOutcome);
    }

    [Fact]
    public async Task NoVerdictSet_HeadShifted_Unchanged()
    {
        var session = SessionWith(OldSha, verdict: null);
        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.Unchanged, result.VerdictOutcome);
    }

    private static ReviewSessionState SessionWith(string lastViewedHeadSha, DraftVerdict? verdict)
        => new(
            LastViewedHeadSha: lastViewedHeadSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: verdict,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
