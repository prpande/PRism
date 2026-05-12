using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// DoD test (b) — retry-from-each-step (spec § 5.4): inject a one-shot failure at each of the four
// mutation methods; the first attempt returns Failed at that step, and a second attempt with the
// at-failure session resumes from where it stopped and converges on Success — with no duplicate
// threads or replies (each id is assigned once across both attempts).
public class RetryFromEachStepTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    private const string Begin = "BeginPendingReviewAsync";
    private const string AttachThread = "AttachThreadAsync";
    private const string AttachReply = "AttachReplyAsync";
    private const string Finalize = "FinalizePendingReviewAsync";

    [Theory]
    [InlineData(Begin)]
    [InlineData(AttachThread)]
    [InlineData(AttachReply)]
    [InlineData(Finalize)]
    public async Task FailsOnFirstCall_RetrySucceeds_NoDuplicates(string failingMethod)
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(failingMethod, new HttpRequestException("simulated one-shot failure"));

        // The Begin case must NOT be resuming (otherwise Begin never runs); the others resume a
        // seeded pending review that already has the parent thread the reply targets.
        var resuming = failingMethod != Begin;
        if (resuming)
        {
            var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_seed", "head1", DateTimeOffset.UtcNow, "");
            pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
                "PRRT_parent", "src/Bar.cs", 1, "RIGHT", "head1",
                Body: "parent body", IsResolved: false,
                Replies: new List<InMemoryReviewSubmitter.InMemoryComment>(), CreatedAt: DateTimeOffset.UtcNow.AddMinutes(-1)));
            fake.SeedPendingReview(Ref, pending);
        }

        var session = SessionFactory.With(
            headSha: "head1",
            pendingReviewId: resuming ? "PRR_seed" : null,
            drafts: new[] { SessionFactory.Draft("d1") },
            replies: resuming ? new[] { SessionFactory.Reply("r1", "PRRT_parent") } : Array.Empty<DraftReply>(),
            summary: "sum");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        // First attempt: fails at the named step.
        var first = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);
        var failed = Assert.IsType<SubmitOutcome.Failed>(first);
        Assert.Equal(StepFor(failingMethod), failed.FailedStep);

        // Second attempt with the at-failure session: succeeds (the one-shot failure is spent).
        var second = await pipeline.SubmitAsync(Ref, failed.NewSession, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);
        Assert.IsType<SubmitOutcome.Success>(second);

        // No duplicates: exactly one AttachThreadAsync (for d1) and, when resuming, one AttachReplyAsync (for r1).
        Assert.Equal(1, fake.AttachThreadCallCount);
        Assert.Equal(resuming ? 1 : 0, fake.AttachReplyCallCount);
        Assert.Null(fake.GetPending(Ref));  // Finalize ran on the retry → pending review gone.
    }

    private static SubmitStep StepFor(string method) => method switch
    {
        Begin => SubmitStep.BeginPendingReview,
        AttachThread => SubmitStep.AttachThreads,
        AttachReply => SubmitStep.AttachReplies,
        Finalize => SubmitStep.Finalize,
        _ => throw new ArgumentOutOfRangeException(nameof(method), method, "unhandled method name"),
    };
}
