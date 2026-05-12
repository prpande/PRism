using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 5 — on Success the pipeline clears PendingReviewId / PendingReviewCommitOid /
// every draft / every reply / DraftSummaryMarkdown / DraftVerdict / DraftVerdictStatus from the
// persisted session (overlay UpdateAsync). The endpoint (PR3) then publishes DraftSubmitted +
// StateChanged OUTSIDE _gate after this returns.
public class SuccessClearsSessionTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task OnSuccess_ClearsEverythingOnThePersistedSession()
    {
        var fake = new InMemoryReviewSubmitter();
        // Resume a seeded pending review whose parent thread the reply targets, so a full draft +
        // reply + summary + verdict session reaches Finalize.
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_parent", "src/Bar.cs", 3, "RIGHT", "head1",
            Body: "parent body", IsResolved: false,
            Replies: new List<InMemoryReviewSubmitter.InMemoryComment>(), CreatedAt: DateTimeOffset.UtcNow.AddMinutes(-1)));
        fake.SeedPendingReview(Ref, pending);

        var session = SessionFactory.With(
            headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1") },
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent") },
            summary: "Summary", verdict: DraftVerdict.Comment);
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);

        var persisted = store.Session(SessionKey)!;
        Assert.Empty(persisted.DraftComments);
        Assert.Empty(persisted.DraftReplies);
        Assert.Null(persisted.DraftSummaryMarkdown);
        Assert.Null(persisted.DraftVerdict);
        Assert.Equal(DraftVerdictStatus.Draft, persisted.DraftVerdictStatus);
        Assert.Null(persisted.PendingReviewId);
        Assert.Null(persisted.PendingReviewCommitOid);
        // Non-submit fields untouched.
        Assert.Equal("head1", persisted.LastViewedHeadSha);
    }
}
