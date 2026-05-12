using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 3 — Attach threads: stamped-and-present → skip; unstamped + no marker → create
// and stamp; plus the per-stamp persistence promise (spec § 5.3 — a process kill mid-step preserves
// what's already attached, observed here via a Finalize failure that leaves the persisted session
// uncleared).
public class AttachThreadsTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task UnstampedDraft_NoMarkerMatch_CallsAttachThreadOnce_ReachesSuccess()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(1, fake.AttachThreadCallCount);
        Assert.Null(fake.GetPending(Ref));  // Finalized.
        Assert.Empty(store.Session(SessionKey)!.DraftComments);  // Success clears the drafts.
    }

    [Fact]
    public async Task StampedDraft_PresentInSnapshot_NotReattached()
    {
        var fake = new InMemoryReviewSubmitter();
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_existing", "src/Foo.cs", 42, "RIGHT", "head1",
            Body: "body\n\n<!-- prism:client-id:d1 -->", IsResolved: false, Replies: new List<InMemoryReviewSubmitter.InMemoryComment>()));
        fake.SeedPendingReview(Ref, pending);

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1", threadId: "PRRT_existing") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(0, fake.AttachThreadCallCount);  // already attached on a prior attempt — not re-created.
    }

    [Fact]
    public async Task UnstampedDraft_AttachThenFinalizeFails_StampPersistedBeforeFinalize()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));

        var session = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        // Per-stamp persistence: the thread id was written to the session before Finalize ran (and
        // the success-clear never reached it because Finalize failed).
        var persistedDraft = Assert.Single(store.Session(SessionKey)!.DraftComments);
        Assert.NotNull(persistedDraft.ThreadId);
        Assert.NotNull(store.Session(SessionKey)!.PendingReviewId);
        // The Failed outcome carries the same at-failure session shape.
        Assert.NotNull(failed.NewSession.DraftComments.Single(d => d.Id == "d1").ThreadId);

        // Retry from the at-failure session: Step 3 sees the stamped draft already present, skips
        // re-attach, and Finalize (no longer failing) converges on Success — no duplicate thread.
        var retry = await pipeline.SubmitAsync(Ref, failed.NewSession, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);
        Assert.IsType<SubmitOutcome.Success>(retry);
        Assert.Equal(1, fake.AttachThreadCallCount);  // exactly one AttachThreadAsync across both attempts.
    }
}
