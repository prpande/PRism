using System.Text.Json;
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
// succeed: PostSubmitGraphQLAsync throws GitHubGraphQLException on ANY non-empty `errors` array —
// stricter than the read-side ThrowIfGraphQLErrorsWithoutData, which tolerates errors-alongside-data
// for the multi-field fetch queries where partial data is legitimately useful.
public sealed partial class GitHubReviewService
{
    public async Task<BeginPendingReviewResult> BeginPendingReviewAsync(
        PrReference reference,
        string commitOid,
        string summaryBody,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(commitOid);
        ArgumentNullException.ThrowIfNull(summaryBody);  // empty body is valid (sent verbatim); null is not

        // Two-call shape: resolve the PR's GraphQL node ID, then create the pending review.
        // Caching the node ID at adapter scope is a deferred optimization — one extra GraphQL
        // hop per submit (~100ms) keeps the adapter stateless and easy to reason about.
        var pullRequestId = await ResolvePullRequestNodeIdAsync(reference, ct).ConfigureAwait(false);

        const string mutation = """
            mutation($prId: ID!, $commitOid: GitObjectID!, $body: String!) {
              addPullRequestReview(input: { pullRequestId: $prId, commitOID: $commitOid, body: $body }) {
                pullRequestReview { id }
              }
            }
            """;

        var data = await PostSubmitGraphQLAsync(
            mutation,
            new { prId = pullRequestId, commitOid, body = summaryBody },
            ct).ConfigureAwait(false);

        if (!TryGetPath(data, out var idEl, "addPullRequestReview", "pullRequestReview", "id")
            || idEl.GetString() is not { Length: > 0 } reviewId)
        {
            throw new GitHubGraphQLException("addPullRequestReview response missing pullRequestReview.id.");
        }
        return new BeginPendingReviewResult(reviewId);
    }

    public async Task<AttachThreadResult> AttachThreadAsync(
        PrReference reference,
        string pendingReviewId,
        DraftThreadRequest draft,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);
        ArgumentNullException.ThrowIfNull(draft);

        // C6 (verified 2026-05-12): AddPullRequestReviewThreadInput.pullRequestReviewId is present and
        // not deprecated, so the pending-review attach uses pullRequestReviewId (not pullRequestId).
        // StartLine / StartSide are reserved for multi-line comments and stay out of the payload.
        const string mutation = """
            mutation($prReviewId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {
              addPullRequestReviewThread(input: {
                pullRequestReviewId: $prReviewId,
                body: $body,
                path: $path,
                line: $line,
                side: $side
              }) {
                thread { id }
              }
            }
            """;

        var data = await PostSubmitGraphQLAsync(
            mutation,
            new
            {
                prReviewId = pendingReviewId,
                body = draft.BodyMarkdown,
                path = draft.FilePath,
                line = draft.LineNumber,
                side = draft.Side,
            },
            ct).ConfigureAwait(false);

        if (!TryGetPath(data, out var idEl, "addPullRequestReviewThread", "thread", "id")
            || idEl.GetString() is not { Length: > 0 } threadId)
        {
            throw new GitHubGraphQLException("addPullRequestReviewThread response missing thread.id.");
        }
        return new AttachThreadResult(threadId);
    }

    public async Task<AttachReplyResult> AttachReplyAsync(
        PrReference reference,
        string pendingReviewId,
        string parentThreadId,
        string replyBody,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);
        ArgumentException.ThrowIfNullOrEmpty(parentThreadId);
        ArgumentNullException.ThrowIfNull(replyBody);

        // pullRequestReviewId is what binds the reply to the pending review (omit it and the reply
        // posts immediately). pullRequestReviewThreadId is the parent thread; body carries the
        // pipeline-injected marker the same way a thread body does.
        const string mutation = """
            mutation($prReviewId: ID!, $threadId: ID!, $body: String!) {
              addPullRequestReviewThreadReply(input: {
                pullRequestReviewId: $prReviewId,
                pullRequestReviewThreadId: $threadId,
                body: $body
              }) {
                comment { id }
              }
            }
            """;

        var data = await PostSubmitGraphQLAsync(
            mutation,
            new { prReviewId = pendingReviewId, threadId = parentThreadId, body = replyBody },
            ct).ConfigureAwait(false);

        if (!TryGetPath(data, out var idEl, "addPullRequestReviewThreadReply", "comment", "id")
            || idEl.GetString() is not { Length: > 0 } commentId)
        {
            throw new GitHubGraphQLException("addPullRequestReviewThreadReply response missing comment.id.");
        }
        return new AttachReplyResult(commentId);
    }

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 15");

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 16");

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 16");

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
        => throw new NotImplementedException("PR1 Task 17");

    // ----- shared helpers -----

    // Resolves the GraphQL node ID for a PR. Kept stateless (re-queried per call) for PR1; a
    // per-PrReference cache is a separable optimization.
    private async Task<string> ResolvePullRequestNodeIdAsync(PrReference reference, CancellationToken ct)
    {
        const string query = """
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) { id }
              }
            }
            """;

        var data = await PostSubmitGraphQLAsync(
            query,
            new { owner = reference.Owner, repo = reference.Repo, number = reference.Number },
            ct).ConfigureAwait(false);

        if (!TryGetPath(data, out var idEl, "repository", "pullRequest", "id")
            || idEl.GetString() is not { Length: > 0 } nodeId)
        {
            throw new GitHubGraphQLException(
                $"Pull request {reference.Owner}/{reference.Repo}#{reference.Number} has no GraphQL node ID (not found, or no access).");
        }
        return nodeId;
    }

    // Posts a GraphQL mutation/query for the submit pipeline. Returns the `data` element (cloned so
    // it survives the JsonDocument disposal). Throws GitHubGraphQLException on ANY non-empty `errors`
    // array — a mutation that reports errors did not apply — or when no `data` object came back.
    // Transport-level failures (non-2xx, DNS, etc.) surface as HttpRequestException from PostGraphQLAsync.
    private async Task<JsonElement> PostSubmitGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var raw = await PostGraphQLAsync(query, variables, ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;

        if (root.TryGetProperty("errors", out var errors)
            && errors.ValueKind == JsonValueKind.Array
            && errors.GetArrayLength() > 0)
        {
            throw new GitHubGraphQLException(
                $"GitHub GraphQL request returned {errors.GetArrayLength()} error(s).",
                errors.GetRawText());
        }

        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            throw new GitHubGraphQLException("GitHub GraphQL response carried no usable data object.");

        return data.Clone();
    }
}
