using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Web.TestHooks;

// Test-only IReviewSubmitter (ADR-S5-1 split), registered as the IReviewSubmitter in dev/test mode.
// PR1 lands the seven interface methods as NotImplementedException stubs — nothing exercises the
// submit path yet (the submit endpoint arrives in PR3). PR7 (plan Task 61) fleshes this out, backed
// by FakeReviewBackingStore, when the DoD E2E suite needs a working in-memory pending review.
internal sealed class FakeReviewSubmitter : IReviewSubmitter
{
    public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
        => throw new NotImplementedException("FakeReviewSubmitter is fleshed out in S5 PR7 (plan Task 61).");
}
