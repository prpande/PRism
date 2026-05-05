using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubPrEnricher : IPrEnricher
{
    private const int ConcurrencyCap = 8;
    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, DateTimeOffset), RawPrInboxItem> _cache = new();

    public GitHubPrEnricher(HttpClient http, Func<Task<string?>> readToken)
    {
        _http = http;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(items);
        if (items.Count == 0) return Array.Empty<RawPrInboxItem>();
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        var done = await Task.WhenAll(items.Select(async raw =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var key = (raw.Reference, raw.UpdatedAt);
                if (_cache.TryGetValue(key, out var cached)) return cached;
                var enriched = await FetchAsync(raw, token, ct).ConfigureAwait(false);
                if (enriched != null) _cache[key] = enriched;
                return enriched;
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        return done.Where(p => p != null).Select(p => p!).ToList();
    }

    private async Task<RawPrInboxItem?> FetchAsync(RawPrInboxItem raw, string? token, CancellationToken ct)
    {
        var url = $"repos/{raw.Reference.Owner}/{raw.Reference.Repo}/pulls/{raw.Reference.Number}";
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
        var head = doc.RootElement.GetProperty("head").GetProperty("sha").GetString() ?? "";
        var additions = doc.RootElement.TryGetProperty("additions", out var a) ? a.GetInt32() : 0;
        var deletions = doc.RootElement.TryGetProperty("deletions", out var d) ? d.GetInt32() : 0;
        var commits = doc.RootElement.TryGetProperty("commits", out var c) ? c.GetInt32() : 1;
        var pushedAt = doc.RootElement.TryGetProperty("pushed_at", out var p)
            ? p.GetDateTimeOffset() : raw.UpdatedAt;

        return raw with
        {
            HeadSha = head, Additions = additions, Deletions = deletions,
            IterationNumberApprox = commits, PushedAt = pushedAt,
        };
    }
}
