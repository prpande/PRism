using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubSectionQueryRunner : ISectionQueryRunner
{
    private static readonly Dictionary<string, string> SectionQueries = new()
    {
        ["review-requested"] = "is:open is:pr review-requested:@me archived:false",
        ["awaiting-author"]  = "is:open is:pr reviewed-by:@me archived:false",
        ["authored-by-me"]   = "is:open is:pr author:@me archived:false",
        ["mentioned"]        = "is:open is:pr mentions:@me archived:false",
        // ci-failing is intentionally NOT mapped here. Its query would be identical to
        // authored-by-me, and InboxRefreshOrchestrator already populates the ci-failing
        // section by running ICiFailingDetector against the authored-by-me superset.
        // Mapping it here would fire a redundant Search API call every tick — wasted budget
        // against GitHub's 30-rpm Search secondary rate limit. ResolveVisibleSections() in
        // the orchestrator still forces "authored-by-me" into the visible set whenever
        // ci-failing is enabled, so the detector gets the data it needs.
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubSectionQueryRunner(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(visibleSectionIds);
        var token = await _readToken().ConfigureAwait(false);
        var tasks = SectionQueries
            .Where(kv => visibleSectionIds.Contains(kv.Key))
            .Select(async kv =>
            {
                try
                {
                    var items = await SearchAsync(kv.Value, token, ct).ConfigureAwait(false);
                    return (kv.Key, (IReadOnlyList<RawPrInboxItem>)items);
                }
#pragma warning disable CA1031 // generic catch — per-section failure isolates per spec/03-poc-features.md § 2 polling. Cancellation and rate-limit propagate.
                catch (Exception ex) when (ex is not OperationCanceledException && ex is not RateLimitExceededException)
#pragma warning restore CA1031
                {
                    return (kv.Key, (IReadOnlyList<RawPrInboxItem>)Array.Empty<RawPrInboxItem>());
                }
            })
            .ToList();
        var done = await Task.WhenAll(tasks).ConfigureAwait(false);
        return done.ToDictionary(t => t.Key, t => t.Item2);
    }

    private async Task<List<RawPrInboxItem>> SearchAsync(string q, string? token, CancellationToken ct)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(q)}&per_page=50";
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

        foreach (var item in items.EnumerateArray())
        {
            var prUrl = item.GetProperty("pull_request").GetProperty("html_url").GetString() ?? "";
            if (!Uri.TryCreate(prUrl, UriKind.Absolute, out var prUri)) continue;
            var path = prUri.AbsolutePath.Trim('/').Split('/');
            if (path.Length < 4 || path[2] != "pull") continue;
            if (!int.TryParse(path[3], out var n)) continue;

            var repo = $"{path[0]}/{path[1]}";
            var login = item.GetProperty("user").GetProperty("login").GetString() ?? "";
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
                1));  // iteration approx
        }
        return result;
    }
}
