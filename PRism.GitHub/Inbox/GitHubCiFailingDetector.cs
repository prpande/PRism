using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubCiFailingDetector : ICiFailingDetector
{
    private const int ConcurrencyCap = 8;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, string), CiStatus> _cache = new();

    public GitHubCiFailingDetector(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<(RawPrInboxItem Item, CiStatus Ci)>> DetectAsync(
        IReadOnlyList<RawPrInboxItem> authoredItems, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(authoredItems);
        if (authoredItems.Count == 0) return Array.Empty<(RawPrInboxItem Item, CiStatus Ci)>();
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        // 5xx / timeout from any per-PR probe propagates here — the orchestrator
        // decides whether to skip the tick. Unlike the section runner (which
        // isolates per-section failures), per-PR failures abort the detect tick.
        var done = await Task.WhenAll(authoredItems.Select(async c =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (string.IsNullOrEmpty(c.HeadSha)) return (Item: c, Ci: CiStatus.None);
                var key = (c.Reference, c.HeadSha);
                if (_cache.TryGetValue(key, out var cached)) return (Item: c, Ci: cached);

                var ci = await ProbeAsync(c.Reference, c.HeadSha, token, ct).ConfigureAwait(false);
                _cache[key] = ci;
                return (Item: c, Ci: ci);
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        return done;
    }

    private async Task<CiStatus> ProbeAsync(PrReference pr, string headSha, string? token, CancellationToken ct)
    {
        var checksTask = FetchChecksAsync(pr, headSha, token, ct);
        var statusesTask = FetchCombinedStatusAsync(pr, headSha, token, ct);
        var results = await Task.WhenAll(checksTask, statusesTask).ConfigureAwait(false);
        var checks = results[0];
        var statuses = results[1];
        if (checks == CiStatus.Failing || statuses == CiStatus.Failing) return CiStatus.Failing;
        if (checks == CiStatus.Pending || statuses == CiStatus.Pending) return CiStatus.Pending;
        return CiStatus.None;
    }

    private async Task<CiStatus> FetchChecksAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/check-runs?per_page=100";
        using var resp = await SendAsync(url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return CiStatus.None;
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("check_runs", out var runs)) return CiStatus.None;
        var anyFailing = false;
        var anyPending = false;
        // "cancelled" classifies as Failing per spec — a user-aborted CI run is
        // treated as a failure signal. Superseded-run filtering (where a new push
        // invalidates an old cancellation) is not handled here; v2 may refine.
        foreach (var r in runs.EnumerateArray())
        {
            var status = r.GetProperty("status").GetString();
            var conclusion = r.TryGetProperty("conclusion", out var cn) ? cn.GetString() : null;
            if (status != "completed") { anyPending = true; continue; }
            if (conclusion is "failure" or "timed_out" or "cancelled") anyFailing = true;
        }
        return anyFailing ? CiStatus.Failing : (anyPending ? CiStatus.Pending : CiStatus.None);
    }

    private async Task<CiStatus> FetchCombinedStatusAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/status";
        using var resp = await SendAsync(url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return CiStatus.None;
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var state = doc.RootElement.TryGetProperty("state", out var s) ? s.GetString() : "success";
        // GitHub's combined-status endpoint returns state="pending" when no legacy
        // statuses are registered; combined with check-runs results in the outer
        // Failing > Pending > None precedence, so an "all-Checks-pass + no-statuses"
        // PR may still surface as Pending. Acceptable for PoC; v2 may refine.
        return state switch
        {
            "failure" or "error" => CiStatus.Failing,
            "pending" => CiStatus.Pending,
            _ => CiStatus.None,
        };
    }

    private async Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
    {
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        return await http.SendAsync(req, ct).ConfigureAwait(false);
    }
}
