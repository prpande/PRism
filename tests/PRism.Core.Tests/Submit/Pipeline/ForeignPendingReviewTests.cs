using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 1 — Detect existing pending review: three outcomes (no pending → Begin → … →
// Success; match by id → resume; foreign → ForeignPendingReviewPromptRequired). DoD tests (c)/(d)
// (the Resume / Discard branches) are driven by the endpoint re-calling SubmitAsync with an
// adjusted session — covered here at the pipeline level by the match-by-id resume case.
public class ForeignPendingReviewTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    private static InMemoryAppStateStore StoreWith(ReviewSessionState session)
    {
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        return store;
    }

    [Fact]
    public async Task Step1_NoPendingReview_ProceedsToBegin_ReachesFinalize_Success()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = SessionFactory.Empty("head1");
        var store = StoreWith(session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Null(fake.GetPending(Ref));  // Finalize ran → pending review gone.
        // The persisted session was cleared (no pending review id left behind).
        Assert.Null(store.Session(SessionKey)!.PendingReviewId);
    }

    [Fact]
    public async Task Step1_OurPendingReviewIdMatches_AndCommitOidMatches_Resumes_Success()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_existing", "head1", DateTimeOffset.UtcNow.AddMinutes(-5), ""));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_existing");
        var store = StoreWith(session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        // Resumed the seeded pending review (no recreate), then finalized it.
        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal("PRR_existing", ((SubmitOutcome.Success)outcome).PullRequestReviewId);
        Assert.Null(fake.GetPending(Ref));
    }

    [Fact]
    public async Task Step1_ForeignPendingReviewExists_ReturnsForeignPendingReviewPromptRequired()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_foreign", "head1", DateTimeOffset.UtcNow.AddDays(-2), "summary"));

        var session = SessionFactory.Empty("head1");  // PendingReviewId is null → doesn't match the foreign one.
        var store = StoreWith(session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var prompt = Assert.IsType<SubmitOutcome.ForeignPendingReviewPromptRequired>(outcome);
        Assert.Equal("PRR_foreign", prompt.Snapshot.PullRequestReviewId);
        // Nothing was finalized or cleared — the foreign review is still pending, our session untouched.
        Assert.NotNull(fake.GetPending(Ref));
    }

    [Fact]
    public async Task Step1_FindOwnPendingReviewFails_ReturnsFailedAtDetectStep()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.FindOwnPendingReviewAsync), new HttpRequestException("simulated transport blip"));

        var session = SessionFactory.Empty("head1");
        var store = StoreWith(session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.DetectExistingPendingReview, failed.FailedStep);
        // Retry: a fresh attempt with the recoverable fake succeeds.
        var retry = await pipeline.SubmitAsync(Ref, failed.NewSession, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);
        Assert.IsType<SubmitOutcome.Success>(retry);
    }
}
