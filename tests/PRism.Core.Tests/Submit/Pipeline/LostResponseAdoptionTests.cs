using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 3 / § 5.3 invariant 3 — the lost-response window: a prior AttachThreadAsync
// succeeded server-side but the response never reached us, so the draft is unstamped locally while
// the server thread carries our <!-- prism:client-id:<id> --> marker. On retry the pipeline adopts
// the server thread by marker (single match) instead of double-posting.
public class LostResponseAdoptionTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task UnstampedDraft_MarkerMatchesServerThread_AdoptsServerId_NoNewAttach()
    {
        var fake = new InMemoryReviewSubmitter();
        // We are resuming our own pending review; one of its threads is the lost-response thread.
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_lost", "src/Foo.cs", 42, "RIGHT", "head1",
            Body: "body content\n\n<!-- prism:client-id:d1 -->", IsResolved: false, Replies: new List<InMemoryReviewSubmitter.InMemoryComment>()));
        fake.SeedPendingReview(Ref, pending);
        // ...but make Finalize fail so we can observe what the draft was stamped with before the clear.
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1", body: "body content") });  // unstamped
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        Assert.Equal(0, fake.AttachThreadCallCount);  // adopted, not re-created.
        // The draft now points at the SERVER's thread id, persisted and reflected in the at-failure session.
        Assert.Equal("PRRT_lost", store.Session(SessionKey)!.DraftComments.Single(d => d.Id == "d1").ThreadId);
        Assert.Equal("PRRT_lost", failed.NewSession.DraftComments.Single(d => d.Id == "d1").ThreadId);
    }
}
