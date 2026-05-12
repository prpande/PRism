using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// DoD test (e) — Step 1's "match by id, but commitOID differs from currentHeadSha" branch (spec
// § 5.2 "Stale-commitOID branch"): delete the orphan pending review, clear PendingReviewId /
// PendingReviewCommitOid / every per-draft ThreadId / every per-reply ReplyCommentId on the
// persisted session, and hand StaleCommitOidRecreating(orphanReviewId, orphanCommitOid) back so
// the dialog can show "recreating against the new head" before the user re-confirms. The drafts
// themselves are preserved — the user Reloads + reconciles + re-submits.
public class StaleCommitOidRetryTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task StaleCommitOid_DeletesOrphan_ReturnsRecreating_ClearsStamps_KeepsDrafts()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_old", "head_OLD", DateTimeOffset.UtcNow, ""));

        var session = SessionFactory.With(
            headSha: "head_OLD", pendingReviewId: "PRR_old", pendingReviewCommitOid: "head_OLD",
            drafts: new[] { SessionFactory.Draft("d1", threadId: "PRRT_stale") },
            replies: new[] { SessionFactory.Reply("r1", "PRRT_old_parent", replyCommentId: "PRRC_stale") },
            summary: "summary");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, currentHeadSha: "head_NEW", NoopProgress.Instance, CancellationToken.None);

        var recreating = Assert.IsType<SubmitOutcome.StaleCommitOidRecreating>(outcome);
        Assert.Equal("PRR_old", recreating.OrphanReviewId);
        Assert.Equal("head_OLD", recreating.OrphanCommitOid);

        Assert.Null(fake.GetPending(Ref));  // orphan deleted server-side.

        var persisted = store.Session(SessionKey)!;
        Assert.Null(persisted.PendingReviewId);
        Assert.Null(persisted.PendingReviewCommitOid);
        Assert.All(persisted.DraftComments, d => Assert.Null(d.ThreadId));
        Assert.All(persisted.DraftReplies, r => Assert.Null(r.ReplyCommentId));
        // Drafts / replies / summary themselves survive — only the server-issued stamps are cleared.
        Assert.Single(persisted.DraftComments);
        Assert.Single(persisted.DraftReplies);
        Assert.Equal("summary", persisted.DraftSummaryMarkdown);
    }

    [Fact]
    public async Task StaleCommitOid_DeleteOrphanFails_ReturnsFailedAtDetectStep()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_old", "head_OLD", DateTimeOffset.UtcNow, ""));
        fake.InjectFailure(nameof(IReviewSubmitter.DeletePendingReviewAsync), new HttpRequestException("simulated"));

        var session = SessionFactory.With(headSha: "head_OLD", pendingReviewId: "PRR_old", pendingReviewCommitOid: "head_OLD");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head_NEW", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.DetectExistingPendingReview, failed.FailedStep);
        // The orphan is still there (delete never succeeded); the session's stamps untouched so a
        // retry re-enters the stale branch cleanly.
        Assert.NotNull(fake.GetPending(Ref));
    }
}
