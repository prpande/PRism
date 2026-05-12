using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.GitHub;

// IReviewSubmitter — the GraphQL pending-review pipeline (S5 PR1).
// See:
//  - docs/specs/2026-05-11-s5-submit-pipeline-design.md § 4 (contract) + § 5.2 (the pipeline steps these feed)
//  - docs/spec/00-verification-notes.md § C6 (addPullRequestReviewThread param shape — verified), § C7 (marker durability — verified), § C9 (empty-pipeline finalize — verified)
//
// Transport reuses the adapter's existing GraphQL plumbing (PostGraphQLAsync + the named "github"
// HttpClient + HostUrlResolver.GraphQlEndpoint). Submit calls are mutations, so they cannot partially
// succeed: PostSubmitGraphQLAsync throws GitHubGraphQLException on ANY non-empty `errors` array
// (stricter than the read-side ThrowIfGraphQLErrorsWithoutData, which tolerates errors-alongside-data).
public sealed partial class GitHubReviewService
{
    public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 12");

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 13");

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 14");

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 15");

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 16");

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 16");

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 17");
}
