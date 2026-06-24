using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

/// <summary>
/// Batched GraphQL inbox reader (#532). ONE aliased
/// query hydrates many PRs at once (head SHA, diff stats, commit count, changed files, pushedAt,
/// merged/closed timestamps) AND computes the viewer's last-review SHA from reviews(last:100).
/// Caches per (Reference, UpdatedAt) so a quiescent inbox issues zero batches. Owns its own
/// rate-limit error model (it does NOT degrade-to-empty like GitHubPrTimelineReader): a 429 or a
/// 200/RATE_LIMITED body throws RateLimitExceededException so InboxPoller backs off; any other
/// transport failure propagates and aborts the tick; a per-alias null/error drops just that ref.
/// </summary>
public sealed partial class GitHubPrBatchReader : IPrBatchReader
{
    private const int MaxBatch = 100;        // GitHub aliased-batch safety cap (mirrors GitHubPrTimelineReader)
    private const int MaxReviewNodes = 100;  // reviews(last:100) page size — a full page signals possible truncation
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;   // late-bound: GraphQL endpoint follows a live host change
    private readonly ILogger<GitHubPrBatchReader> _log;
    private readonly ConcurrentDictionary<(PrReference, DateTimeOffset), BatchPrData> _cache = new();
    // The cache key is (ref, UpdatedAt), but ViewerLastReviewSha is viewer-dependent. A PAT swap to a
    // different account (POST /api/auth/replace) keeps UpdatedAt unchanged, so without this guard the
    // cache would serve the previous viewer's review SHA. Clear on viewer change. Refreshes are
    // serialized by the poller, so a plain field (no lock) is sufficient.
    private string? _cachedViewerLogin;

    public GitHubPrBatchReader(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        Func<string> readHost,
        ILogger<GitHubPrBatchReader>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
        _log = log ?? NullLogger<GitHubPrBatchReader>.Instance;
    }

    public async Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(items);
        // Viewer changed (e.g. PAT swapped to another account) → every cached ViewerLastReviewSha is
        // for the wrong viewer; drop the whole cache so this tick re-fetches under the new identity.
        if (_cachedViewerLogin is { } prev && !string.Equals(prev, viewerLogin, StringComparison.OrdinalIgnoreCase))
            _cache.Clear();
        _cachedViewerLogin = viewerLogin;

        var result = new Dictionary<PrReference, BatchPrData>();
        if (items.Count == 0) { _cache.Clear(); return result; }

        // Partition into cache hits vs stale (key = (ref, UpdatedAt) — UpdatedAt bumps on any PR
        // activity, including a new review, so an unchanged key guarantees nothing we read changed).
        // Collect the live ref set in the same pass for the eviction prune below.
        var stale = new List<RawPrInboxItem>();
        var liveRefs = new HashSet<PrReference>();
        foreach (var it in items)
        {
            liveRefs.Add(it.Reference);
            if (_cache.TryGetValue((it.Reference, it.UpdatedAt), out var hit))
                result[it.Reference] = hit;
            else
                stale.Add(it);
        }

        if (stale.Count > 0)
        {
            var token = await _readToken().ConfigureAwait(false);
            var host = _readHost();
            using var http = _httpFactory.CreateClient("github");

            for (var i = 0; i < stale.Count; i += MaxBatch)
            {
                var chunk = stale.GetRange(i, Math.Min(MaxBatch, stale.Count - i));
                foreach (var (it, data) in await FetchChunkAsync(http, token, host, chunk, viewerLogin, ct).ConfigureAwait(false))
                {
                    _cache[(it.Reference, it.UpdatedAt)] = data;
                    result[it.Reference] = data;
                }
            }
        }

        InboxCacheEviction.PruneAbsent(_cache, liveRefs);
        return result;
    }

    private async Task<List<(RawPrInboxItem Item, BatchPrData Data)>> FetchChunkAsync(
        HttpClient http, string? token, string host,
        List<RawPrInboxItem> chunk, string viewerLogin, CancellationToken ct)
    {
        var aliased = chunk.Select((it, idx) => (Alias: $"a{idx}", Item: it)).ToList();
        var query = BuildQuery(aliased);

        string body;
        try
        {
            // Route through the shared transport so the PAT same-host egress guard stays in the
            // chain. PostAsync throws HttpRequestException (StatusCode preserved) on non-2xx and
            // returns the raw 200 body verbatim. Empty variables — owner/name/number are inlined.
            body = await GitHubGraphQL.PostAsync(http, token, host, _log, query, new { }, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.TooManyRequests)
        {
            // REST parity: a hydration/awaiting 429 backs the poller off. PostAsync's exception
            // carries no Retry-After, so RetryAfter is null and the poller runs the next tick at
            // its normal cadence (InboxPoller has no separate max-backoff).
            throw new RateLimitExceededException(
                "GitHub GraphQL rate limit (HTTP 429) during inbox batch hydration.", retryAfter: null);
        }

        using var doc = JsonDocument.Parse(body);

        // Primary rate limit arrives as HTTP 200 with errors[].type == RATE_LIMITED (data:null).
        // Inspect errors[] BEFORE reading data (which is null in that case).
        if (HasRateLimitError(doc.RootElement))
            throw new RateLimitExceededException(
                "GitHub GraphQL rate limit (200/RATE_LIMITED) during inbox batch hydration.", retryAfter: null);

        var results = new List<(RawPrInboxItem, BatchPrData)>();
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            // 200 with no usable data object (non-rate-limit errors-without-data). Degrade: every
            // ref in this chunk drops this tick (not a fallback). Observable via the log.
            Log.RefsDropped(_log, chunk.Count);
            return results;
        }

        // Cost measurement (#532 AC): record the point cost per chunk for the PR ## Proof.
        if (data.TryGetProperty("rateLimit", out var rl) && rl.ValueKind == JsonValueKind.Object)
            Log.RateLimitCost(_log, chunk.Count,
                rl.TryGetProperty("cost", out var co) && co.ValueKind == JsonValueKind.Number ? co.GetInt32() : -1,
                rl.TryGetProperty("remaining", out var re) && re.ValueKind == JsonValueKind.Number ? re.GetInt32() : -1);

        var dropped = 0;
        foreach (var (alias, it) in aliased)
        {
            try
            {
                if (data.TryGetProperty(alias, out var repoNode)
                    && repoNode.ValueKind == JsonValueKind.Object
                    && TryParse(repoNode, it, viewerLogin, out var parsed))
                    results.Add((it, parsed));
                else
                    dropped++;
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                // One malformed alias (e.g. a non-date timestamp string) drops just that ref,
                // mirroring the REST enricher's per-PR malformed-payload isolation (#322).
                dropped++;
            }
        }
        if (dropped > 0) Log.RefsDropped(_log, dropped);
        return results;
    }

    private static string BuildQuery(List<(string Alias, RawPrInboxItem Item)> aliased)
    {
        var sb = new StringBuilder("query{");
        foreach (var (alias, it) in aliased)
        {
            sb.Append(alias).Append(": repository(owner:")
              .Append(JsonSerializer.Serialize(it.Reference.Owner)).Append(", name:")
              .Append(JsonSerializer.Serialize(it.Reference.Repo)).Append("){ pullRequest(number:")
              .Append(it.Reference.Number.ToString(CultureInfo.InvariantCulture))
              .Append("){ headRefOid additions deletions changedFiles commits{ totalCount } ")
              .Append("mergedAt closedAt isDraft mergeable mergeStateStatus reviewDecision ")
              .Append("headRepository{ pushedAt } ")
              .Append("reviews(last:100){ nodes{ author{ login } submittedAt commit{ oid } } } ")
              .Append("latestReviews(first:100){ nodes{ author{ login } state } } } } } ");
        }
        sb.Append("rateLimit{ cost remaining } }");
        return sb.ToString();
    }

    private bool TryParse(JsonElement repoNode, RawPrInboxItem raw, string viewerLogin, out BatchPrData data)
    {
        data = null!;
        if (!repoNode.TryGetProperty("pullRequest", out var pr) || pr.ValueKind != JsonValueKind.Object)
            return false;

        var headSha = pr.TryGetProperty("headRefOid", out var h) ? h.GetString() ?? "" : "";
        if (string.IsNullOrEmpty(headSha)) return false;   // no head → cannot hydrate; drop

        var additions = NumOr(pr, "additions", 0);
        var deletions = NumOr(pr, "deletions", 0);
        var changedFiles = NumOr(pr, "changedFiles", 0);
        var commitCount = pr.TryGetProperty("commits", out var c) ? NumOr(c, "totalCount", 1) : 1;

        // pushedAt: BOTH guards — present object AND String-kind scalar — else fall back to UpdatedAt.
        var pushedAt = raw.UpdatedAt;
        if (pr.TryGetProperty("headRepository", out var hr) && hr.ValueKind == JsonValueKind.Object
            && hr.TryGetProperty("pushedAt", out var pa) && pa.ValueKind == JsonValueKind.String)
            pushedAt = pa.GetDateTimeOffset();

        DateTimeOffset? mergedAt = pr.TryGetProperty("mergedAt", out var ma) && ma.ValueKind == JsonValueKind.String
            ? ma.GetDateTimeOffset() : null;
        DateTimeOffset? closedAt = pr.TryGetProperty("closedAt", out var ca) && ca.ValueKind == JsonValueKind.String
            ? ca.GetDateTimeOffset() : null;

        var isDraft = pr.TryGetProperty("isDraft", out var dr) && dr.ValueKind == JsonValueKind.True;
        var mergeable = pr.TryGetProperty("mergeable", out var mg) && mg.ValueKind == JsonValueKind.String ? mg.GetString() : null;
        var mergeStateStatus = pr.TryGetProperty("mergeStateStatus", out var mss) && mss.ValueKind == JsonValueKind.String ? mss.GetString() : null;
        var reviewDecision = pr.TryGetProperty("reviewDecision", out var rdv) && rdv.ValueKind == JsonValueKind.String ? rdv.GetString() : null;

        var prState = PrStates.FromTimestamps(mergedAt, closedAt);
        var readiness = MergeReadinessRule.Derive(prState, isDraft, mergeable, mergeStateStatus, reviewDecision);
        var (approvals, changesRequested) = GitHubPrParser.CountLatestReviews(pr);

        data = new BatchPrData(headSha, additions, deletions, commitCount, changedFiles,
                               pushedAt, mergedAt, closedAt,
                               ParseViewerLastReviewSha(pr, viewerLogin, raw.Reference),
                               readiness, approvals, changesRequested);
        return true;
    }

    private static int NumOr(JsonElement obj, string name, int fallback)
        => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;

    // Computes the viewer's last-review SHA from the GraphQL shape:
    // the viewer's review with the max submittedAt among reviews with a non-null submittedAt AND a
    // non-empty commit.oid. NO state filter (deliberately NOT GitHubPrParser.ParseViewerReview,
    // which excludes DISMISSED/PENDING) — see spec § Awaiting-author parity.
    private string? ParseViewerLastReviewSha(JsonElement pr, string viewerLogin, PrReference reference)
    {
        if (!pr.TryGetProperty("reviews", out var reviews)
            || !reviews.TryGetProperty("nodes", out var nodes)
            || nodes.ValueKind != JsonValueKind.Array)
            return null;

        // Documented delta 1 (spec): reviews(last:100) carries no pageInfo, so a full page is the
        // only available truncation signal. A PR with >100 reviews whose viewer's latest is older
        // than the 100 most recent could yield a stale SHA — emit a ReviewPagesCapped-style log.
        if (nodes.GetArrayLength() == MaxReviewNodes)
            Log.ReviewsTruncated(_log, reference.Owner, reference.Repo, reference.Number, MaxReviewNodes);

        string? best = null;
        DateTimeOffset? bestAt = null;
        foreach (var rv in nodes.EnumerateArray())
        {
            if (rv.ValueKind != JsonValueKind.Object) continue;
            try
            {
                var login = GitHubGraphQL.TryGetPath(rv, out var l, "author", "login") ? l.GetString() : null;
                if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;

                var oid = GitHubGraphQL.TryGetPath(rv, out var o, "commit", "oid") ? o.GetString() : null;
                if (string.IsNullOrEmpty(oid)) continue;

                if (!rv.TryGetProperty("submittedAt", out var sa) || sa.ValueKind != JsonValueKind.String) continue;
                var at = sa.GetDateTimeOffset();

                if (bestAt is null || at > bestAt.Value) { bestAt = at; best = oid; }
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                // One malformed review node (e.g. a non-date submittedAt that passes the
                // String-kind guard but throws in GetDateTimeOffset) is skipped, not propagated —
                // matches the deleted GitHubAwaitingAuthorFilter's per-review isolation so a single
                // bad node can't bubble out of TryParse and drop the whole PR from the batch.
            }
        }
        return best;
    }

    private static bool HasRateLimitError(JsonElement root)
    {
        if (!root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array)
            return false;
        foreach (var e in errors.EnumerateArray())
            if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("type", out var t)
                && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
                return true;
        return false;
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Inbox batch reader dropped {Count} ref(s) this tick (per-alias null / non-object / malformed)")]
        internal static partial void RefsDropped(ILogger logger, int count);

        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Inbox batch reviews(last:{Cap}) returned a full page for {Owner}/{Repo}#{Number}; viewer's most-recent review may be older than the cap")]
        internal static partial void ReviewsTruncated(ILogger logger, string owner, string repo, int number, int cap);

        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Inbox batch GraphQL: {Refs} ref(s), rateLimit cost={Cost} remaining={Remaining}")]
        internal static partial void RateLimitCost(ILogger logger, int refs, int cost, int remaining);
    }
}
