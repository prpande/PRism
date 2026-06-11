using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed partial class GitHubAwaitingAuthorFilter : IAwaitingAuthorFilter
{
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
        using var sem = new SemaphoreSlim(GitHubHttp.ConcurrencyCap);

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

    // GitHub returns reviews paginated at per_page=100 with no documented sort order. Rather
    // than trust array position, select the viewer review with the maximum submitted_at among
    // reviews that carry a real (string-kind) submitted_at AND a non-empty commit_id; its
    // commit_id is the "last reviewed head". The running best persists across all walked pages
    // (capped at MaxReviewPages, mirroring the CI detector), so the max is global, not per-page.
    // PENDING drafts (submitted_at: null) and null/empty commit_id reviews are skipped (#367).
    // Per-review JSON access is isolated so one malformed review item is skipped, not the tick.
    private async Task<string?> FetchLastReviewShaAsync(
        PrReference pr, string viewerLogin, string? token, CancellationToken ct)
    {
        string? best = null;
        DateTimeOffset? bestSubmittedAt = null;
        string? nextUrl = null;
        var initialUrl = $"repos/{pr.Owner}/{pr.Repo}/pulls/{pr.Number}/reviews?per_page=100";
        using var http = _httpFactory.CreateClient("github");

        for (var page = 0; page < MaxReviewPages; page++)
        {
            // #320: route every page through the shared transport (relative initial URL or the
            // absolute Link `next` URL — GitHubHttp's same-host guard validates the latter).
            var requestUrl = nextUrl ?? initialUrl;
            using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, requestUrl, token, ct).ConfigureAwait(false);
            if (resp.StatusCode == HttpStatusCode.NotFound) return best;
            GitHubHttp.ThrowIfRateLimited(resp);
            resp.EnsureSuccessStatusCode();

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            foreach (var review in doc.RootElement.EnumerateArray())
            {
                try
                {
                    var login = review.GetProperty("user").GetProperty("login").GetString();
                    if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;

                    var commitId = review.TryGetProperty("commit_id", out var c) ? c.GetString() : null;
                    if (string.IsNullOrEmpty(commitId)) continue; // null/empty commit_id → no comparable head

                    // submitted_at is JSON null for PENDING drafts; gate on the value KIND so a
                    // null-kind is a clean skip, not a GetDateTimeOffset() throw caught as malformed
                    // (mirrors GitHubReviewService.cs:917). A non-date STRING still reaches the parse
                    // below and throws FormatException → handled by the malformed-item guard.
                    if (!review.TryGetProperty("submitted_at", out var sa) ||
                        sa.ValueKind != JsonValueKind.String) continue;
                    var submittedAt = sa.GetDateTimeOffset();

                    // Strictly-greater; the explicit null-guard takes the first eligible review
                    // (a bare lifted `>` against a null DateTimeOffset? returns false).
                    if (bestSubmittedAt is null || submittedAt > bestSubmittedAt.Value)
                    {
                        bestSubmittedAt = submittedAt;
                        best = commitId;
                    }
                }
                catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
                {
                    Log.ReviewItemSkipped(_log, ex, pr.Owner, pr.Repo, pr.Number);
                }
            }

            nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var n) ? n : null;
            if (nextUrl is null) break;
        }

        // A non-null nextUrl after the loop means we stopped at the page cap with more pages
        // pending — the only non-break exit (the break fires only when nextUrl is null). So the
        // most-recent review may be truncated; signal it rather than silently wrong-shaping.
        if (nextUrl is not null)
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
