using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Task 6 — cancellation path: when the caller cancels the CancellationToken mid-pipeline,
// SubmitAsync must return SubmitOutcome.Cancelled (carrying the last-Started step) rather than
// letting the OperationCanceledException escape.
public class SubmitPipelineCancelTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    private static InMemoryAppStateStore StoreWith(ReviewSessionState session)
    {
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        return store;
    }

    // Deterministic: use a pre-cancelled CancellationToken + inject an OperationCanceledException
    // into BeginPendingReviewAsync so the fake throws it synchronously. No time-based race —
    // the pipeline is guaranteed to cancel at the BeginPendingReview step without any Task.Delay.
    [Fact]
    public async Task SubmitAsync_when_ct_canceled_mid_step_returns_Cancelled()
    {
        var fake = new InMemoryReviewSubmitter();
        // Inject the OCE into the first mutable-state call so the pipeline hits it during Step 2
        // (BeginPendingReview). FindOwnPendingReviewAsync runs first and returns null (no seeded
        // pending review), so the pipeline proceeds to Begin — that is where the OCE is raised.
        fake.InjectFailure(nameof(IReviewSubmitter.BeginPendingReviewAsync), new OperationCanceledException("cancelled by test"));

        // Session with no drafts and no pending review — simplest path that reaches BeginPendingReview.
        var session = SessionFactory.Empty("head1");
        var store = StoreWith(session);

        using var cts = new CancellationTokenSource();
        cts.Cancel();  // pre-cancel so ct.IsCancellationRequested is true when the when-filter fires

        var progress = new RecordingProgress();
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", progress, cts.Token);

        // Must return Cancelled, not throw.
        var cancelled = Assert.IsType<SubmitOutcome.Cancelled>(outcome);
        // The last-Started step before the cancellation was BeginPendingReview.
        Assert.Equal(SubmitStep.BeginPendingReview, cancelled.LastStep);
        // Reason must be non-empty.
        Assert.False(string.IsNullOrWhiteSpace(cancelled.Reason));
    }
}
