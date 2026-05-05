using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubAwaitingAuthorFilter : IAwaitingAuthorFilter
{
    private const int ConcurrencyCap = 8;
    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, string), string?> _lastReviewShaCache = new();

    public GitHubAwaitingAuthorFilter(HttpClient http, Func<Task<string?>> readToken)
    {
        _http = http;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
        string viewerLogin, IReadOnlyList<RawPrInboxItem> candidates, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        if (candidates.Count == 0) return Array.Empty<RawPrInboxItem>();
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

        return probed.Where(p => p != null).Select(p => p!).ToList();
    }

    private async Task<string?> FetchLastReviewShaAsync(
        PrReference pr, string viewerLogin, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/pulls/{pr.Number}/reviews?per_page=100";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        string? best = null;
        foreach (var review in doc.RootElement.EnumerateArray())
        {
            var login = review.GetProperty("user").GetProperty("login").GetString();
            if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;
            var sha = review.TryGetProperty("commit_id", out var s) ? s.GetString() : null;
            if (sha != null) best = sha; // last in the array = most recent
        }
        return best;
    }
}
