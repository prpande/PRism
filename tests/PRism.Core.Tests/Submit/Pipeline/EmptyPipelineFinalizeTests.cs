using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// DoD test (a) — the empty-pipeline finalize (spec § 5.2 "Empty-pipeline finalize"): a summary-only
// review with a Comment verdict and no inline content. Steps 3 (attach threads) and 4 (attach
// replies) are skipped entirely — no progress events for either — and Step 5 runs against the
// pending review with nothing attached. (The Submit Review button's enable rule (e) blocks the
// no-content-at-all case before the pipeline ever runs, so Step 5 only ever sees an explicit
// "Comment with summary, no inline content" choice.)
public class EmptyPipelineFinalizeTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task SummaryOnly_NoThreadsNoReplies_StepsAttachAreSkipped_FinalizeRuns()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = SessionFactory.With(headSha: "head1", summary: "Summary only", verdict: DraftVerdict.Comment);
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var progress = new RecordingProgress();
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", progress, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(0, fake.AttachThreadCallCount);
        Assert.Equal(0, fake.AttachReplyCallCount);

        // No AttachThreads / AttachReplies progress at all — those steps were skipped, not run-then-zero.
        Assert.DoesNotContain(progress.Events, e => e.Step == SubmitStep.AttachThreads);
        Assert.DoesNotContain(progress.Events, e => e.Step == SubmitStep.AttachReplies);
        // Begin and Finalize both ran and succeeded.
        Assert.Contains(progress.Events, e => e.Step == SubmitStep.BeginPendingReview && e.Status == SubmitStepStatus.Succeeded);
        Assert.Contains(progress.Events, e => e.Step == SubmitStep.Finalize && e.Status == SubmitStepStatus.Succeeded);

        // Summary was passed through to the pending review (now finalized, so no longer pending).
        Assert.Null(fake.GetPending(Ref));
        // Success cleared the session's summary + verdict.
        var persisted = store.Session(SessionKey)!;
        Assert.Null(persisted.DraftSummaryMarkdown);
        Assert.Null(persisted.DraftVerdict);
    }
}
