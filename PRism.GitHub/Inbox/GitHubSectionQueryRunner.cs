using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed partial class GitHubSectionQueryRunner : ISectionQueryRunner
{
    private static readonly Dictionary<string, string> SectionQueries = new()
    {
        ["review-requested"] = "is:open is:pr review-requested:@me archived:false",
        ["awaiting-author"]  = "is:open is:pr reviewed-by:@me archived:false",
        ["authored-by-me"]   = "is:open is:pr author:@me archived:false",
        ["mentioned"]        = "is:open is:pr mentions:@me archived:false",
        // CI is not a section — InboxRefreshOrchestrator probes ICiFailingDetector across all
        // live sections, so no standalone ci query is mapped here.
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<DateTimeOffset> _clock;
    private readonly ILogger<GitHubSectionQueryRunner> _log;

    public GitHubSectionQueryRunner(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        Func<DateTimeOffset> clock,
        ILogger<GitHubSectionQueryRunner>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _clock = clock;
        _log = log ?? NullLogger<GitHubSectionQueryRunner>.Instance;
    }

    public async Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(visibleSectionIds);
        var token = await _readToken().ConfigureAwait(false);
        if (_log.IsEnabled(LogLevel.Debug))
#pragma warning disable CA1873 // Guarded above; analyzer doesn't pattern-match the IsEnabled call.
            Log.QueryAllStarted(_log,
                string.Join(",", visibleSectionIds.OrderBy(s => s, StringComparer.Ordinal)),
                token is { Length: > 0 });
#pragma warning restore CA1873
        var tasks = SectionQueries
            .Where(kv => visibleSectionIds.Contains(kv.Key))
            .Select(async kv =>
            {
                try
                {
                    var items = await SearchAsync(kv.Value, token, ct).ConfigureAwait(false);
                    Log.SectionQueryComplete(_log, kv.Key, items.Count);
                    return (kv.Key, (IReadOnlyList<RawPrInboxItem>)items);
                }
#pragma warning disable CA1031 // generic catch — per-section failure isolates per spec/03-poc-features.md § 2 polling. Cancellation and rate-limit propagate.
                catch (Exception ex) when (ex is not OperationCanceledException && ex is not RateLimitExceededException)
#pragma warning restore CA1031
                {
                    Log.SectionQueryFailed(_log, ex, kv.Key);
                    return (kv.Key, (IReadOnlyList<RawPrInboxItem>)Array.Empty<RawPrInboxItem>());
                }
            })
            .ToList();
        var done = await Task.WhenAll(tasks).ConfigureAwait(false);
        return done.ToDictionary(t => t.Key, t => t.Item2);
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(
        int windowDays, CancellationToken ct)
    {
        var cutoff = _clock().UtcDateTime.Date.AddDays(-windowDays)
            .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var token = await _readToken().ConfigureAwait(false);

        var queries = new[]
        {
            ("recently-closed/involves", $"is:pr is:closed involves:@me closed:>={cutoff} archived:false"),
            ("recently-closed/reviewed-by", $"is:pr is:closed reviewed-by:@me closed:>={cutoff} archived:false"),
        };

        var lists = await Task.WhenAll(queries.Select(async q =>
        {
            try { return (IReadOnlyList<RawPrInboxItem>)await SearchAsync(q.Item2, token, ct, sort: "updated").ConfigureAwait(false); }
#pragma warning disable CA1031 // generic catch — per-sub-query failure isolates, consistent with QueryAllAsync. Cancellation and rate-limit propagate.
            catch (Exception ex) when (ex is not OperationCanceledException && ex is not RateLimitExceededException)
#pragma warning restore CA1031
            {
                Log.SectionQueryFailed(_log, ex, q.Item1);
                return Array.Empty<RawPrInboxItem>();
            }
        })).ConfigureAwait(false);

        return lists.SelectMany(l => l)
            .GroupBy(r => r.Reference)
            .Select(g => g.First())
            .ToList();
    }

    private async Task<List<RawPrInboxItem>> SearchAsync(string q, string? token, CancellationToken ct, string? sort = null)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(q)}&per_page=50"
            + (sort is null ? "" : $"&sort={Uri.EscapeDataString(sort)}&order=desc");
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
        {
            var retryAfter = resp.Headers.RetryAfter?.Delta;
            throw new RateLimitExceededException(
                "GitHub Search API rate-limited (429); orchestrator should skip this tick.",
                retryAfter);
        }
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);

        var result = new List<RawPrInboxItem>();
        if (!doc.RootElement.TryGetProperty("items", out var items)) return result;

        // The items[] EnumerateArray() above stays outside this try — a non-array body is a
        // section-level failure isolated by QueryAllAsync's per-section catch. Here we isolate a
        // single malformed *item* so one poisoned search result degrades that item, not the section. (#322)
        foreach (var item in items.EnumerateArray())
        {
            try
            {
                var prUrl = item.GetProperty("pull_request").GetProperty("html_url").GetString() ?? "";
                if (!Uri.TryCreate(prUrl, UriKind.Absolute, out var prUri)) continue;
                var path = prUri.AbsolutePath.Trim('/').Split('/');
                if (path.Length < 4 || path[2] != "pull") continue;
                if (!int.TryParse(path[3], out var n)) continue;

                var repo = $"{path[0]}/{path[1]}";
                var userEl = item.GetProperty("user");
                var login = userEl.GetProperty("login").GetString() ?? "";
                var avatarUrl = userEl.TryGetProperty("avatar_url", out var av) && av.ValueKind == JsonValueKind.String
                    ? av.GetString() : null;
                var title = item.GetProperty("title").GetString() ?? "";
                var updated = item.GetProperty("updated_at").GetDateTimeOffset();
                var comments = item.TryGetProperty("comments", out var c) ? c.GetInt32() : 0;

                result.Add(new RawPrInboxItem(
                    new PrReference(path[0], path[1], n),
                    title, login, repo,
                    updated, updated, // pushed-at not in Search API; placeholder, refined in fan-out
                    comments,
                    0, 0, // additions/deletions not in Search API; refined in fan-out
                    "",   // head_sha not in Search API; refined in fan-out
                    1,    // iteration approx
                    AvatarUrl: avatarUrl));
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                Log.ItemSkipped(_log, ex);
            }
        }
        return result;
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug, Message = "GitHub section queries starting (sections=[{Sections}], has-token={HasToken})")]
        internal static partial void QueryAllStarted(ILogger logger, string sections, bool hasToken);

        [LoggerMessage(Level = LogLevel.Debug, Message = "GitHub section '{Section}' returned {Count} items")]
        internal static partial void SectionQueryComplete(ILogger logger, string section, int count);

        [LoggerMessage(Level = LogLevel.Warning, Message = "GitHub section '{Section}' query failed; section will be empty this tick")]
        internal static partial void SectionQueryFailed(ILogger logger, Exception ex, string section);

        [LoggerMessage(Level = LogLevel.Debug, Message = "GitHub search item skipped (malformed JSON shape)")]
        internal static partial void ItemSkipped(ILogger logger, Exception ex);
    }
}
