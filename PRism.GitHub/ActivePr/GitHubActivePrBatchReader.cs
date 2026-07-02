using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;

namespace PRism.GitHub.ActivePr;

// Sibling reader to GitHubPrBatchReader (#598 Slice B). ONE aliased GraphQL query hydrates
// merge-readiness + comment/review counts for every subscribed PR per active-poll tick,
// replacing the old N x 3 REST round-trips. Distinct query shape from the inbox reader (no
// headRepository{pushedAt} / diff-stat / viewer-last-review-SHA; needs reviewDecision +
// mergeStateStatus + counts), so it is a separate class. The SHARED parts — HTTP transport
// (GitHubGraphQL.PostAsync), the 429 + 200/RATE_LIMITED model (GitHubGraphQL.ThrowIfRateLimited),
// the merge-readiness alias cap (GitHubGraphQL.MergeReadinessAliasCap), per-alias null isolation,
// CountLatestReviews — are reused, not forked.
public sealed class GitHubActivePrBatchReader : IActivePrBatchReader
{
    // Shared with the inbox reader — rationale at GitHubGraphQL.MergeReadinessAliasCap (#667).
    private const int MaxBatch = GitHubGraphQL.MergeReadinessAliasCap;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;
    private readonly ILogger<GitHubActivePrBatchReader> _log;

    public GitHubActivePrBatchReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost,
        ILogger<GitHubActivePrBatchReader>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
        _log = log ?? NullLogger<GitHubActivePrBatchReader>.Instance;
    }

    public async Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
        IReadOnlyList<PrReference> refs, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(refs);
        var result = new Dictionary<PrReference, ActivePrPollSnapshot>();
        if (refs.Count == 0) return result;

        foreach (var chunk in Chunk(refs, MaxBatch))
        {
            var aliased = chunk.Select((r, i) => ($"a{i}", r)).ToList();
            using var http = _httpFactory.CreateClient("github");
            // Shared dispatch (#665): build envelope → POST → 429/RATE_LIMITED translation → parse.
            // Per-alias parsing stays here (it differs from the inbox reader's).
            using var doc = await GitHubGraphQL.RunAliasedBatchAsync(
                http, await _readToken().ConfigureAwait(false), _readHost(), _log,
                aliased, r => r, ActiveSelection, "active-PR batch poll", ct).ConfigureAwait(false);

            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
                continue;

            foreach (var (alias, prRef) in aliased)
            {
                if (!data.TryGetProperty(alias, out var repoNode) || repoNode.ValueKind != JsonValueKind.Object)
                    continue;
                if (TryParse(repoNode, out var snapshot)) result[prRef] = snapshot;
            }
        }
        return result;
    }

    // The per-PR field selection inside pullRequest{ … }, consumed by the shared
    // GitHubGraphQL.RunAliasedBatchAsync envelope. Must end at the reviewRequests close with NO
    // trailing space: the envelope resumes with a leading-space " } } ", so a trailing space here
    // would insert a double space into the query. The envelope supplies the pullRequest + repository
    // closes. Distinct from the
    // inbox selection (no diff-stat / pushedAt / viewer-last-review; has baseRefOid/state +
    // reviewThreads comment counts). Byte-identity pinned by GitHubActivePrBatchReaderTests.
    private const string ActiveSelection =
        "headRefOid baseRefOid state isDraft mergeable mergeStateStatus reviewDecision comments{ totalCount } " +
        "reviewThreads(first:100){ nodes{ comments{ totalCount } } } reviews{ totalCount } " +
        "latestReviews(first:20){ nodes{ author{ login avatarUrl } state } } " +
        "reviewRequests(first:20){ nodes{ requestedReviewer{ ... on User{ login avatarUrl } ... on Team{ name } } } }";

    private static bool TryParse(JsonElement repoNode, out ActivePrPollSnapshot snapshot)
    {
        snapshot = null!;
        if (!repoNode.TryGetProperty("pullRequest", out var pr) || pr.ValueKind != JsonValueKind.Object)
            return false;

        string Str(string n) => pr.TryGetProperty(n, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "";
        string? StrOrNull(string n) => pr.TryGetProperty(n, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        int TotalCount(string conn) => pr.TryGetProperty(conn, out var c) && c.ValueKind == JsonValueKind.Object
            && c.TryGetProperty("totalCount", out var tc) && tc.ValueKind == JsonValueKind.Number ? tc.GetInt32() : 0;

        var headSha = Str("headRefOid");
        if (string.IsNullOrEmpty(headSha)) return false;

        var state = PrStates.FromGitHub(StrOrNull("state"), merged: false);
        var isDraft = pr.TryGetProperty("isDraft", out var d) && d.ValueKind == JsonValueKind.True;
        var readiness = MergeReadinessRule.Derive(state, isDraft, StrOrNull("mergeable"), StrOrNull("mergeStateStatus"), StrOrNull("reviewDecision"));
        var (approvals, changes) = GitHubPrParser.CountLatestReviews(pr);
        var (approvers, changesRequestedBy) = GitHubPrParser.ParseLatestReviewers(pr);
        var awaitingReviewers = GitHubPrParser.ParseRequestedReviewers(pr);

        snapshot = new ActivePrPollSnapshot(
            HeadSha: headSha,
            BaseSha: Str("baseRefOid"),
            Mergeability: Str("mergeable"),
            PrState: state,
            CommentCount: CountReviewComments(pr),  // REST pulls/{n}/comments parity: per-COMMENT, not per-thread
            ReviewCount: TotalCount("reviews"),
            MergeReadiness: readiness,
            Approvals: approvals,
            ChangesRequested: changes,
            Approvers: approvers,
            ChangesRequestedBy: changesRequestedBy,
            AwaitingReviewers: awaitingReviewers,
            IsDraft: isDraft,
            IssueCommentCount: TotalCount("comments"));
        return true;
    }

    // REST pulls/{n}/comments returns one entry PER inline review comment; a single reviewThread
    // holds multiple comments, so reviewThreads.totalCount (thread count) is NOT parity. Sum the
    // per-thread comment counts instead (caps at 100 threads — the pagination ceiling).
    private static int CountReviewComments(JsonElement pr)
    {
        if (!pr.TryGetProperty("reviewThreads", out var rt)
            || !rt.TryGetProperty("nodes", out var nodes)
            || nodes.ValueKind != JsonValueKind.Array)
            return 0;
        int total = 0;
        foreach (var thread in nodes.EnumerateArray())
        {
            if (thread.ValueKind != JsonValueKind.Object) continue;
            if (thread.TryGetProperty("comments", out var c) && c.ValueKind == JsonValueKind.Object
                && c.TryGetProperty("totalCount", out var tc) && tc.ValueKind == JsonValueKind.Number)
                total += tc.GetInt32();
        }
        return total;
    }

    private static IEnumerable<IReadOnlyList<PrReference>> Chunk(IReadOnlyList<PrReference> items, int size)
    {
        for (int i = 0; i < items.Count; i += size)
            yield return items.Skip(i).Take(Math.Min(size, items.Count - i)).ToList();
    }
}
