using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Revision R11 — the pipeline accepts an optional getCurrentHeadShaAsync callback (the endpoint
// wires it to a fresh PollActivePrAsync, not the ~30s poller cache, in PR5). Just before Finalize
// it re-polls; if the PR's head drifted since the pipeline started (a push landed mid-pipeline) it
// bails with Failed(Finalize, …) so the user Reloads + reconciles before re-submitting. (PR2 ships
// the capability; the endpoint wiring + the full UX land in PR5.)
public class PreFinalizeHeadShaReprollTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task HeadDriftedBeforeFinalize_ReturnsFailedAtFinalize_WithoutFinalizing()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = SessionFactory.With(headSha: "head1", summary: "s");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store, getCurrentHeadShaAsync: _ => Task.FromResult("head2"));

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        Assert.Contains("head_sha", failed.ErrorMessage, StringComparison.Ordinal);
        // Begin ran (a pending review was created) but Finalize did not — it's still pending.
        Assert.NotNull(fake.GetPending(Ref));
    }

    [Fact]
    public async Task HeadUnchangedBeforeFinalize_ProceedsToSuccess()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = SessionFactory.With(headSha: "head1", summary: "s");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store, getCurrentHeadShaAsync: _ => Task.FromResult("head1"));

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Null(fake.GetPending(Ref));
    }
}
