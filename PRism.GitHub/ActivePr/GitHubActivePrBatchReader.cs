using System.Globalization;
using System.Text;
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
// the 100-alias cap, per-alias null isolation, CountLatestReviews — are reused, not forked.
public sealed class GitHubActivePrBatchReader : IActivePrBatchReader
{
    private const int MaxBatch = 100;
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
            var query = BuildQuery(aliased);
            using var http = _httpFactory.CreateClient("github");
            string json;
            try
            {
                json = await GitHubGraphQL.PostAsync(http, await _readToken().ConfigureAwait(false),
                    _readHost(), _log, query, new { }, ct).ConfigureAwait(false);
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                throw new RateLimitExceededException("GitHub GraphQL rate limit (HTTP 429) during active-PR batch poll.", retryAfter: null);
            }

            using var doc = JsonDocument.Parse(json);
            GitHubGraphQL.ThrowIfRateLimited(doc.RootElement, "active-PR batch poll");
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
            AwaitingReviewers: awaitingReviewers);
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

    private static string BuildQuery(List<(string Alias, PrReference Ref)> aliased)
    {
        var sb = new StringBuilder("query{");
        foreach (var (alias, r) in aliased)
            sb.Append(alias).Append(": repository(owner:")
              .Append(JsonSerializer.Serialize(r.Owner)).Append(", name:")
              .Append(JsonSerializer.Serialize(r.Repo)).Append("){ pullRequest(number:")
              .Append(r.Number.ToString(CultureInfo.InvariantCulture))
              .Append("){ headRefOid baseRefOid state isDraft mergeable mergeStateStatus reviewDecision ")
              .Append("reviewThreads(first:100){ nodes{ comments{ totalCount } } } reviews{ totalCount } ")
              // latestReviews is collapsed (one per reviewer); 20 covers any real PR for the
              // approval/changes-requested counts and keeps the per-alias cost low (#593).
              // avatarUrl + reviewRequests (#593) feed the live detail readiness popover's people section.
              .Append("latestReviews(first:20){ nodes{ author{ login avatarUrl } state } } ")
              .Append("reviewRequests(first:20){ nodes{ requestedReviewer{ ... on User{ login avatarUrl } ... on Team{ name } } } } } } ");
        sb.Append("rateLimit{ cost remaining } }");
        return sb.ToString();
    }

    private static IEnumerable<IReadOnlyList<PrReference>> Chunk(IReadOnlyList<PrReference> items, int size)
    {
        for (int i = 0; i < items.Count; i += size)
            yield return items.Skip(i).Take(Math.Min(size, items.Count - i)).ToList();
    }
}
