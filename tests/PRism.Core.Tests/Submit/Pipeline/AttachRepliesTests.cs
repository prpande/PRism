using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 4 — Attach replies: stamped-and-present → skip; unstamped + no marker in the
// parent thread's reply chain → AttachReplyAsync + stamp.
public class AttachRepliesTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    private static InMemoryReviewSubmitter.InMemoryPendingReview PendingWithParent(string parentThreadId, params InMemoryReviewSubmitter.InMemoryComment[] replies)
    {
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            parentThreadId, "src/Foo.cs", 1, "RIGHT", "head1",
            Body: "parent body\n\n<!-- prism:client-id:parentdraft -->", IsResolved: false, Replies: replies.ToList()));
        return pending;
    }

    [Fact]
    public async Task UnstampedReply_NoMarkerMatch_CallsAttachReplyOnce_ReachesSuccess()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, PendingWithParent("PRRT_parent"));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent") });  // unstamped
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(1, fake.AttachReplyCallCount);
        Assert.Null(fake.GetPending(Ref));  // Finalized.
    }

    [Fact]
    public async Task Step4SnapshotRefetchReturnsNull_ReturnsRetryableFailure_DoesNotDemoteReplies()
    {
        // GitHub's reviews(...) list query can lag right after Begin/AttachThread; Step 4's re-fetch
        // then returns null even though the pending review exists. That must NOT be mistaken for
        // "every reply's parent thread was deleted" — it's a retryable step failure, and the reply
        // stays Draft so the next attempt (with a settled snapshot) can post it.
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, PendingWithParent("PRRT_parent"));
        fake.FindOwnReturnsNullFromCall = 2;  // Step 1's FindOwn succeeds; Step 4's re-fetch returns null.

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.AttachReplies, failed.FailedStep);
        Assert.Equal(DraftStatus.Draft, failed.NewSession.DraftReplies.Single(r => r.Id == "r1").Status);  // NOT demoted.
        Assert.Equal(DraftStatus.Draft, store.Session(SessionKey)!.DraftReplies.Single(r => r.Id == "r1").Status);
        Assert.Equal(0, fake.AttachReplyCallCount);
    }

    [Fact]
    public async Task StampedReply_PresentInSnapshot_NotRecreated()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, PendingWithParent("PRRT_parent",
            new InMemoryReviewSubmitter.InMemoryComment("PRRC_existing", "reply body\n\n<!-- prism:client-id:r1 -->")));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent", replyCommentId: "PRRC_existing") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(0, fake.AttachReplyCallCount);  // already attached on a prior attempt.
    }
}
