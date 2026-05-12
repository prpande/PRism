using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 3 "Multi-match" / § 5.3 invariant 3 / § 17 decision 23 — GitHub's pending-review
// listing isn't strictly read-your-writes consistent, so a lost-response window followed by a retry
// that wrote a duplicate (because the original wasn't yet visible) can leave N>1 server threads
// carrying the same draft's marker. The pipeline adopts the earliest (lowest createdAt) and
// best-effort-deletes the rest, emitting a notice via the onDuplicateMarker callback. Without this
// it would Finalize a review with duplicate threads — exactly what the marker scheme prevents.
public class MultiMarkerMatchTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task TwoServerThreadsCarrySameMarker_AdoptsEarliest_DeletesOthers_FiresNotice()
    {
        var fake = new InMemoryReviewSubmitter();
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        var now = DateTimeOffset.UtcNow;
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_later", "src/Foo.cs", 42, "RIGHT", "head1",
            Body: "body\n\n<!-- prism:client-id:d1 -->", IsResolved: false,
            Replies: new List<InMemoryReviewSubmitter.InMemoryComment>(), CreatedAt: now));
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_earlier", "src/Foo.cs", 42, "RIGHT", "head1",
            Body: "body\n\n<!-- prism:client-id:d1 -->", IsResolved: false,
            Replies: new List<InMemoryReviewSubmitter.InMemoryComment>(), CreatedAt: now.AddSeconds(-2)));
        fake.SeedPendingReview(Ref, pending);
        // Stop at Finalize so we can observe what the draft was stamped with and which threads remain.
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1") });  // unstamped
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);

        var notices = new List<string>();
        var pipeline = new SubmitPipeline(fake, store, onDuplicateMarker: notices.Add);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        Assert.Equal(0, fake.AttachThreadCallCount);  // adopted, not re-created.

        // Adopted the earliest; the later one was deleted server-side.
        Assert.Equal("PRRT_earlier", store.Session(SessionKey)!.DraftComments.Single(d => d.Id == "d1").ThreadId);
        var remaining = fake.GetPending(Ref)!.Threads;
        Assert.Single(remaining);
        Assert.Equal("PRRT_earlier", remaining[0].Id);

        Assert.NotEmpty(notices);
        Assert.Contains(notices, n => n.Contains("PRRT_earlier", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TwoServerCommentsCarrySameReplyMarker_AdoptsEarliestById_FiresNotice()
    {
        var fake = new InMemoryReviewSubmitter();
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_parent", "src/Foo.cs", 1, "RIGHT", "head1",
            Body: "parent\n\n<!-- prism:client-id:pd -->", IsResolved: false,
            Replies: new List<InMemoryReviewSubmitter.InMemoryComment>
            {
                new("PRRC_b", "reply\n\n<!-- prism:client-id:r1 -->"),
                new("PRRC_a", "reply\n\n<!-- prism:client-id:r1 -->"),
            }));
        fake.SeedPendingReview(Ref, pending);
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent") });  // unstamped
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);

        var notices = new List<string>();
        var pipeline = new SubmitPipeline(fake, store, onDuplicateMarker: notices.Add);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(0, fake.AttachReplyCallCount);  // adopted, not re-created.
        Assert.Equal("PRRC_a", store.Session(SessionKey)!.DraftReplies.Single(r => r.Id == "r1").ReplyCommentId);  // earliest by id.
        Assert.NotEmpty(notices);
    }
}
