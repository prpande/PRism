using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubPrEnricher : IPrEnricher
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, DateTimeOffset), RawPrInboxItem> _cache = new();

    public GitHubPrEnricher(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(items);
        if (items.Count == 0) { _cache.Clear(); return Array.Empty<RawPrInboxItem>(); }
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(GitHubHttp.ConcurrencyCap);

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

        InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
        return done.Where(p => p != null).Select(p => p!).ToList();
    }

    private async Task<RawPrInboxItem?> FetchAsync(RawPrInboxItem raw, string? token, CancellationToken ct)
    {
        var url = $"repos/{raw.Reference.Owner}/{raw.Reference.Repo}/pulls/{raw.Reference.Number}";
        using var http = _httpFactory.CreateClient("github");
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        GitHubHttp.ThrowIfRateLimited(resp);
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        // The HTTP send / EnsureSuccessStatusCode / body read above stay OUTSIDE this try so a
        // transient transport failure still propagates and aborts the tick (the poller retries the
        // whole snapshot). Here we isolate a malformed *payload* per-PR: one poisoned PR detail
        // returns null (the caller drops nulls), it does not abort the enrich tick. No logger is
        // added — a silent null-drop matches the enricher's existing 404 → null behavior. (#322)
        try
        {
            using var doc = JsonDocument.Parse(body);
            var head = doc.RootElement.GetProperty("head").GetProperty("sha").GetString() ?? "";
            var additions = doc.RootElement.TryGetProperty("additions", out var a) ? a.GetInt32() : 0;
            var deletions = doc.RootElement.TryGetProperty("deletions", out var d) ? d.GetInt32() : 0;
            var commits = doc.RootElement.TryGetProperty("commits", out var c) ? c.GetInt32() : 1;
            // pulls/{n} response does NOT have pushed_at at root. The closest field is
            // head.repo.pushed_at (the head branch's repo last-push timestamp). If that is
            // also missing (very rare; only on closed PRs whose head ref was deleted),
            // fall back to updated_at — the field is informational in S2; v2 / S3 may
            // query commits/{sha} for the precise head-commit timestamp if needed.
            DateTimeOffset pushedAt = raw.UpdatedAt;
            if (doc.RootElement.TryGetProperty("head", out var headEl) &&
                headEl.TryGetProperty("repo", out var headRepo) &&
                headRepo.ValueKind == System.Text.Json.JsonValueKind.Object &&
                headRepo.TryGetProperty("pushed_at", out var pushedAtProp) &&
                pushedAtProp.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                pushedAt = pushedAtProp.GetDateTimeOffset();
            }

            DateTimeOffset? mergedAt = null;
            if (doc.RootElement.TryGetProperty("merged_at", out var mAt) &&
                mAt.ValueKind == JsonValueKind.String)
                mergedAt = mAt.GetDateTimeOffset();

            DateTimeOffset? closedAt = null;
            if (doc.RootElement.TryGetProperty("closed_at", out var cAt) &&
                cAt.ValueKind == JsonValueKind.String)
                closedAt = cAt.GetDateTimeOffset();

            return raw with
            {
                HeadSha = head, Additions = additions, Deletions = deletions,
                IterationNumberApprox = commits, PushedAt = pushedAt,
                MergedAt = mergedAt, ClosedAt = closedAt,
            };
        }
        catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
        {
            return null; // one malformed PR detail skips that PR; caller drops nulls
        }
    }
}
