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

    public async Task FinalizePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        SubmitEvent verdict,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);

        var graphqlEvent = verdict switch
        {
            SubmitEvent.Approve => "APPROVE",
            SubmitEvent.RequestChanges => "REQUEST_CHANGES",
            SubmitEvent.Comment => "COMMENT",
            _ => throw new ArgumentOutOfRangeException(nameof(verdict), verdict, "Unknown SubmitEvent."),
        };

        // No body argument — the summary body was carried into BeginPendingReviewAsync.
        const string mutation = """
            mutation($prReviewId: ID!, $event: PullRequestReviewEvent!) {
              submitPullRequestReview(input: { pullRequestReviewId: $prReviewId, event: $event }) {
                pullRequestReview { id state }
              }
            }
            """;

        // Discard the response — success is the absence of a thrown exception (PostSubmitGraphQLAsync
        // throws on any GraphQL error; SubmitPipeline maps that to a Finalize-step failure outcome).
        _ = await PostSubmitGraphQLAsync(
            mutation,
            new { prReviewId = pendingReviewId, @event = graphqlEvent },
            ct).ConfigureAwait(false);
    }

    public async Task DeletePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);

        const string mutation = """
            mutation($prReviewId: ID!) {
              deletePullRequestReview(input: { pullRequestReviewId: $prReviewId }) {
                pullRequestReview { id }
              }
            }
            """;

        _ = await PostSubmitGraphQLAsync(mutation, new { prReviewId = pendingReviewId }, ct).ConfigureAwait(false);
    }

    public async Task DeletePendingReviewThreadAsync(
        PrReference reference,
        string pullRequestReviewThreadId,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(pullRequestReviewThreadId);

        // GitHub's GraphQL has no "delete a review thread" mutation — only deletePullRequestReviewComment
        // (by comment node ID). A review thread disappears when its last comment is deleted, so deleting
        // every comment on the thread removes it. Under the multi-marker-match defense (§ 5.2 step 3) a
        // duplicate thread carries only its body comment, so this is usually a single delete; the loop
        // covers the rare with-replies case too. (The plan's Task 16 named a `deletePullRequestReviewThread`
        // mutation that does not exist — see the deferrals sidecar.)
        const string lookup = """
            query($threadId: ID!) {
              node(id: $threadId) {
                ... on PullRequestReviewThread {
                  comments(first: 100) { nodes { id } }
                }
              }
            }
            """;

        var data = await PostSubmitGraphQLAsync(lookup, new { threadId = pullRequestReviewThreadId }, ct).ConfigureAwait(false);

        // node:null → the thread is already gone; nothing to delete (the caller is best-effort, so treat as success).
        if (!data.TryGetProperty("node", out var node) || node.ValueKind != JsonValueKind.Object) return;
        if (!TryGetPath(node, out var commentNodes, "comments", "nodes") || commentNodes.ValueKind != JsonValueKind.Array) return;

        const string deleteComment = """
            mutation($id: ID!) {
              deletePullRequestReviewComment(input: { id: $id }) {
                pullRequestReview { id }
              }
            }
            """;

        // Best-effort throughout: a per-comment delete that fails (already gone, transient error)
        // is swallowed so the remaining comments are still attempted. Leaving a partially-stripped
        // thread is harmless — it's UI noise the multi-marker defense already tolerates — and far
        // better than aborting the cleanup of every subsequent duplicate. (A lookup-query failure
        // above still propagates, consistent with the other submit methods.)
        foreach (var c in commentNodes.EnumerateArray())
        {
            if (!(c.TryGetProperty("id", out var idEl) && idEl.GetString() is { Length: > 0 } commentId))
                continue;
            try
            {
                _ = await PostSubmitGraphQLAsync(deleteComment, new { id = commentId }, ct).ConfigureAwait(false);
            }
            catch (GitHubGraphQLException)
            {
                // Comment already deleted, or some other GraphQL-level failure — keep going.
            }
            catch (HttpRequestException)
            {
                // Transport hiccup on one delete — keep going; the leftover thread is tolerable.
            }
        }
    }

    public async Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(
        PrReference reference,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);

        // One round-trip: the PR's PENDING reviews (GitHub allows one per user — pick the viewer's
        // via viewerDidAuthor) plus all of its review threads. PullRequestReview has no `threads`
        // connection, and the thread-level fields (isResolved / diffSide / line / originalLine) live
        // on PullRequestReviewThread — so threads are grouped to the pending review by their root
        // comment's pullRequestReview.id.
        // reviews(first: 50): GitHub allows one pending review per *user* per PR, so this lists at most
        // one pending review per active reviewer — 50 is generous headroom that the viewer's own review
        // will always be inside (first: 1 would be wrong: a co-reviewer's pending review could sort
        // ahead of the viewer's, making viewerDidAuthor false on node[0] and yielding a false-negative
        // null). reviewThreads(first: 100) DOES have a realistic ceiling on a busy PR — and pagination
        // truncation is silent (no `errors` array), so PostSubmitGraphQLAsync won't catch it; the
        // pageInfo.hasNextPage guard below fails loud instead of returning an incomplete snapshot.
        const string query = """
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) {
                  reviews(first: 50, states: [PENDING]) {
                    nodes { id viewerDidAuthor commit { oid } createdAt }
                  }
                  reviewThreads(first: 100) {
                    pageInfo { hasNextPage }
                    nodes {
                      id
                      path
                      line
                      diffSide
                      originalLine
                      isResolved
                      comments(first: 100) {
                        pageInfo { hasNextPage }
                        nodes { id body createdAt originalCommit { oid } pullRequestReview { id } }
                      }
                    }
                  }
                }
              }
            }
            """;

        var data = await PostSubmitGraphQLAsync(
            query,
            new { owner = reference.Owner, repo = reference.Repo, number = reference.Number },
            ct).ConfigureAwait(false);

        if (!TryGetPath(data, out var pull, "repository", "pullRequest") || pull.ValueKind != JsonValueKind.Object)
            return null;
        if (!TryGetPath(pull, out var reviewNodes, "reviews", "nodes") || reviewNodes.ValueKind != JsonValueKind.Array)
            return null;

        JsonElement? viewerPending = null;
        foreach (var r in reviewNodes.EnumerateArray())
        {
            if (r.TryGetProperty("viewerDidAuthor", out var v) && v.ValueKind == JsonValueKind.True)
            {
                viewerPending = r;
                break;
            }
        }
        if (viewerPending is not { } review) return null;

        if (!review.TryGetProperty("id", out var pridEl) || pridEl.GetString() is not { Length: > 0 } pendingReviewId)
            throw new GitHubGraphQLException("Pending review node missing id.");
        var commitOid = TryGetPath(review, out var oidEl, "commit", "oid") ? oidEl.GetString() ?? "" : "";
        var createdAt = review.TryGetProperty("createdAt", out var ca) && ca.ValueKind == JsonValueKind.String
            ? ca.GetDateTimeOffset()
            : default;

        // Fail loud rather than return an incomplete snapshot — see the query comment above.
        if (TryGetPath(pull, out var hasNextPage, "reviewThreads", "pageInfo", "hasNextPage")
            && hasNextPage.ValueKind == JsonValueKind.True)
        {
            throw new GitHubGraphQLException(
                $"Pull request {reference.Owner}/{reference.Repo}#{reference.Number} has more than 100 review threads; " +
                "FindOwnPendingReviewAsync cannot return a complete pending-review snapshot. (PoC: review-thread pagination is not implemented.)");
        }

        var threads = new List<PendingReviewThreadSnapshot>();
        if (TryGetPath(pull, out var threadNodes, "reviewThreads", "nodes") && threadNodes.ValueKind == JsonValueKind.Array)
        {
            foreach (var thread in threadNodes.EnumerateArray())
            {
                var comments = TryGetPath(thread, out var cn, "comments", "nodes") && cn.ValueKind == JsonValueKind.Array
                    ? cn.EnumerateArray().ToArray()
                    : Array.Empty<JsonElement>();
                if (comments.Length == 0) continue;

                // Fail loud if a thread's comment chain is truncated — the inclusion test below
                // ("does our pending review own any of these comments?") is unsound on a partial
                // page (our reply could be on page 2, so the thread would be wrongly excluded and
                // Step 4 would demote a reply we actually posted). Same fail-loud-over-partial stance
                // as the reviewThreads cap; cursor pagination on both is the deferred fix.
                if (TryGetPath(thread, out var cHasNextPage, "comments", "pageInfo", "hasNextPage")
                    && cHasNextPage.ValueKind == JsonValueKind.True)
                {
                    var truncatedThreadId = thread.TryGetProperty("id", out var ttid) ? ttid.GetString() ?? "?" : "?";
                    throw new GitHubGraphQLException(
                        $"Review thread {truncatedThreadId} on {reference.Owner}/{reference.Repo}#{reference.Number} has more than 100 comments; " +
                        "FindOwnPendingReviewAsync cannot reliably determine pending-review membership of a truncated comment chain. (PoC: comment pagination is not implemented.)");
                }

                // Include this thread iff our pending review owns *any* comment on it — the thread it
                // created (root comment is ours), OR an existing thread it merely replied to (a later
                // comment is ours). SubmitPipeline's Step 4 verifies replies against these per-thread
                // comment chains, so a reply's parent thread MUST be in the snapshot even though that
                // thread's root comment belongs to a prior review. The thread's BodyMarkdown is the
                // root comment's body — which carries no PRism marker for a replied-to-only thread, so
                // Step 3's lost-response marker scan never false-adopts it.
                var ownsAComment = false;
                foreach (var c in comments)
                {
                    if (TryGetPath(c, out var prrId, "pullRequestReview", "id")
                        && string.Equals(prrId.GetString(), pendingReviewId, StringComparison.Ordinal))
                    {
                        ownsAComment = true;
                        break;
                    }
                }
                if (!ownsAComment) continue;

                threads.Add(ProjectPendingReviewThread(thread, comments));
            }
        }

        return new OwnPendingReviewSnapshot(pendingReviewId, commitOid, createdAt, threads);
    }

    private static PendingReviewThreadSnapshot ProjectPendingReviewThread(JsonElement thread, JsonElement[] comments)
    {
        var root = comments[0];
        var threadId = thread.TryGetProperty("id", out var tid) ? tid.GetString() ?? "" : "";
        IReadOnlyList<PendingReviewCommentSnapshot> replies = comments.Length > 1
            ? comments.Skip(1).Select(c => new PendingReviewCommentSnapshot(
                c.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "",
                c.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "")).ToList()
            : Array.Empty<PendingReviewCommentSnapshot>();

        // A pending-review thread is freshly created against a commit, so `line` (or at least
        // `originalLine`) is always set. If both are absent the response is malformed — fail loud
        // rather than emit LineNumber:0, which would poison reconciliation on Resume.
        var lineNumber = ReadInt(thread, "line") ?? ReadInt(thread, "originalLine")
            ?? throw new GitHubGraphQLException($"Pending-review thread {threadId} has neither line nor originalLine.");

        return new PendingReviewThreadSnapshot(
            PullRequestReviewThreadId: threadId,
            FilePath: thread.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "",
            LineNumber: lineNumber,
            Side: thread.TryGetProperty("diffSide", out var ds) ? ds.GetString() ?? "" : "",
            OriginalCommitOid: TryGetPath(root, out var ocOid, "originalCommit", "oid") ? ocOid.GetString() ?? "" : "",
            // The reconciliation pipeline's LineMatching step compares anchored content character-equal
            // against file lines, so an empty value matches every blank line — PR5's Resume endpoint
            // MUST enrich this from the file content at originalCommit before any imported draft is
            // reconciled. The GitHub adapter has no file content here, so it leaves it empty.
            OriginalLineContent: "",
            IsResolved: thread.TryGetProperty("isResolved", out var ir) && ir.ValueKind == JsonValueKind.True,
            BodyMarkdown: root.TryGetProperty("body", out var rb) ? rb.GetString() ?? "" : "",
            // PullRequestReviewThread has no createdAt; the root comment's createdAt is the closest proxy.
            CreatedAt: root.TryGetProperty("createdAt", out var cca) && cca.ValueKind == JsonValueKind.String
                ? cca.GetDateTimeOffset()
                : default,
            Comments: replies);
    }

    private static int? ReadInt(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n)
            ? n
            : null;

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
    //
    // This fail-loud-on-errors rule is applied to the submit pipeline's *queries* too
    // (FindOwnPendingReviewAsync, ResolvePullRequestNodeIdAsync), deliberately stricter than the
    // read-side ThrowIfGraphQLErrorsWithoutData, which tolerates errors-alongside-partial-data for
    // the display fetches (GetPrDetailAsync etc.). The submit pipeline's detection / node-resolution
    // steps are correctness-critical — acting on a partially-errored thread list could create a
    // duplicate thread or drop a draft on Resume — so a partial result is treated as a failure the
    // pipeline retries, not as data to act on. (A genuine "PR / repo not found" comes back as
    // data:null with no `errors`, so it still flows through to a clean null return at the caller.)
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
