using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed partial class GitHubAwaitingAuthorFilter : IAwaitingAuthorFilter
{
    private const int ConcurrencyCap = 8;
    private const int MaxReviewPages = 10;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly ILogger<GitHubAwaitingAuthorFilter> _log;
    private readonly ConcurrentDictionary<(PrReference, string), string?> _lastReviewShaCache = new();

    public GitHubAwaitingAuthorFilter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        ILogger<GitHubAwaitingAuthorFilter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _log = log ?? NullLogger<GitHubAwaitingAuthorFilter>.Instance;
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
        string viewerLogin, IReadOnlyList<RawPrInboxItem> candidates, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        if (candidates.Count == 0) { _lastReviewShaCache.Clear(); return Array.Empty<RawPrInboxItem>(); }
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        // 5xx / timeout from any per-PR probe propagates here — the orchestrator
        // decides whether to skip the tick. Unlike the section runner (which isolates
        // per-section failures), per-PR failures abort the filter tick.
        var probed = await Task.WhenAll(candidates.Select(async c =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (string.IsNullOrEmpty(c.HeadSha)) return null; // not enriched; skip
                var key = (c.Reference, c.HeadSha);
                if (_lastReviewShaCache.TryGetValue(key, out var cached))
                    return cached != null && cached != c.HeadSha ? c : null;

                var lastReviewSha = await FetchLastReviewShaAsync(c.Reference, viewerLogin, token, ct)
                    .ConfigureAwait(false);
                _lastReviewShaCache[key] = lastReviewSha;
                return lastReviewSha != null && lastReviewSha != c.HeadSha ? c : null;
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        InboxCacheEviction.PruneAbsent(_lastReviewShaCache, candidates.Select(c => c.Reference).ToHashSet());
        return probed.Where(p => p != null).Select(p => p!).ToList();
    }

    // GitHub returns reviews in ascending order and paginates at per_page=100. Reading only
    // page 1 takes the OLDEST 100 reviews when a PR has >100 — so the genuinely-most-recent
    // review is on a later page and "last in the array" is wrong. Link-walk every page (capped
    // at MaxReviewPages, mirroring the CI detector) keeping the last viewer-authored commit_id
    // seen across all pages. Per-review JSON access is isolated so one malformed review item is
    // skipped, not the whole tick. (#322) The selection rule (last non-null viewer commit_id) is
    // unchanged here — null-commit_id "latest review" selection is a tracked follow-up.
    private async Task<string?> FetchLastReviewShaAsync(
        PrReference pr, string viewerLogin, string? token, CancellationToken ct)
    {
        string? best = null;
        Uri? nextUri = null;
        var initialUrl = $"repos/{pr.Owner}/{pr.Repo}/pulls/{pr.Number}/reviews?per_page=100";
        using var http = _httpFactory.CreateClient("github");

        var page = 0;
        for (; page < MaxReviewPages; page++)
        {
            var requestUri = nextUri ?? new Uri(initialUrl, UriKind.Relative);
            using var req = new HttpRequestMessage(HttpMethod.Get, requestUri);
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.StatusCode == HttpStatusCode.NotFound) return best;
            if (resp.StatusCode == HttpStatusCode.TooManyRequests)
                throw new RateLimitExceededException(
                    "GitHub rate-limited (429); orchestrator should skip this tick.",
                    resp.Headers.RetryAfter?.Delta);
            resp.EnsureSuccessStatusCode();

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            foreach (var review in doc.RootElement.EnumerateArray())
            {
                try
                {
                    var login = review.GetProperty("user").GetProperty("login").GetString();
                    if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;
                    var sha = review.TryGetProperty("commit_id", out var s) ? s.GetString() : null;
                    if (sha != null) best = sha; // ascending order → last seen overall = most recent
                }
                catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
                {
                    Log.ReviewItemSkipped(_log, ex, pr.Owner, pr.Repo, pr.Number);
                }
            }

            nextUri = GitHubLinkHeader.TryGetNext(resp);
            if (nextUri is null) break;
        }

        if (page >= MaxReviewPages && nextUri is not null)
            Log.ReviewPagesCapped(_log, pr.Owner, pr.Repo, pr.Number, MaxReviewPages);

        return best;
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning,
            Message = "GitHub reviews pagination hit the {Cap}-page cap for {Owner}/{Repo}#{Number}; most-recent review may be truncated")]
        internal static partial void ReviewPagesCapped(ILogger logger, string owner, string repo, int number, int cap);

        [LoggerMessage(Level = LogLevel.Debug,
            Message = "GitHub review item skipped (malformed JSON shape) for {Owner}/{Repo}#{Number}")]
        internal static partial void ReviewItemSkipped(ILogger logger, Exception ex, string owner, string repo, int number);
    }
}
