using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

// Fault-isolated notifications reader. Mirrors GitHubReceivedEventsReader:
// degrade-don't-throw on ANY non-success / transport failure. Keeps only
// PullRequest subjects; others (Issues, Releases, etc.) are silently dropped.
public sealed partial class GitHubNotificationsReader : INotificationsReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubNotificationsReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct)
    {
        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            var sinceParam = Uri.EscapeDataString(since.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"notifications?all=true&since={sinceParam}&per_page={PerPage}");
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return new NotificationsResult([], Degraded: true);

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return new NotificationsResult([], Degraded: true);

            var list = new List<RawNotification>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
                if (Parse(el) is { } n) list.Add(n);
            return new NotificationsResult(list, Degraded: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return new NotificationsResult([], Degraded: true); }
    }

    private static RawNotification? Parse(JsonElement el)
    {
        if (!el.TryGetProperty("subject", out var subject)) return null;
        if (!subject.TryGetProperty("type", out var type) || type.GetString() != "PullRequest") return null;
        if (!subject.TryGetProperty("url", out var urlEl)) return null;
        var apiUrl = urlEl.GetString();
        if (string.IsNullOrEmpty(apiUrl)) return null;
        var m = PullsUrl().Match(apiUrl);
        if (!m.Success) return null;
        // TryParse, not Parse: the regex guarantees digits but not magnitude. A malformed
        // or oversized digit run would overflow int and throw OverflowException, which the
        // ReadAsync catch filter does NOT cover (only Http/Json/TaskCanceled) — it would
        // escape and 500 /api/activity, violating degrade-don't-throw. Drop instead.
        if (!int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var pr))
            return null;

        var repo = el.TryGetProperty("repository", out var r) && r.TryGetProperty("full_name", out var fn)
            ? fn.GetString() : null;
        if (string.IsNullOrEmpty(repo)) return null;

        var reason = el.TryGetProperty("reason", out var re) ? re.GetString() ?? "" : "";
        var title = subject.TryGetProperty("title", out var t) ? t.GetString() : null;
        var ts = el.TryGetProperty("updated_at", out var u) && u.TryGetDateTimeOffset(out var dto)
            ? dto : DateTimeOffset.MinValue;
        return new RawNotification(repo, reason, pr, title, apiUrl, ts);
    }

    [GeneratedRegex(@"/pulls/(\d+)$")]
    private static partial Regex PullsUrl();
}
