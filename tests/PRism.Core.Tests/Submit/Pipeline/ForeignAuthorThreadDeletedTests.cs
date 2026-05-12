using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// DoD test (f) — Step 4's parent-thread-deleted case (spec § 5.2 step 4): the parent thread's
// author deleted it on github.com between submit attempts, so AttachReplyAsync can't land. The
// pipeline demotes the reply to Stale (persisted) and returns Failed(AttachReplies, …); submit then
// blocks via rule (b) on the next attempt until the user discards or rewrites it.
public class ForeignAuthorThreadDeletedTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task AttachReply_ParentThreadGone_DemotesReplyToStale_ReturnsFailedAtAttachReplies()
    {
        var fake = new InMemoryReviewSubmitter();
        // Our pending review exists, but the parent thread the reply targets does NOT.
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, ""));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_deleted") });  // unstamped, parent gone
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.AttachReplies, failed.FailedStep);
        Assert.Contains("parent thread", failed.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, fake.AttachReplyCallCount);  // never even attempted — the snapshot already showed the parent gone.

        // The reply is demoted to Stale, both in the at-failure session and in the persisted store.
        Assert.Equal(DraftStatus.Stale, failed.NewSession.DraftReplies.Single(r => r.Id == "r1").Status);
        Assert.Equal(DraftStatus.Stale, store.Session(SessionKey)!.DraftReplies.Single(r => r.Id == "r1").Status);

        // The pending review is still pending (Finalize never ran).
        Assert.NotNull(fake.GetPending(Ref));
    }
}
