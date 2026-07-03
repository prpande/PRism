using System;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
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
    private readonly ILogger<GitHubNotificationsReader>? _logger;

    public GitHubNotificationsReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken,
        ILogger<GitHubNotificationsReader>? logger = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _logger = logger;
    }

    public async Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct)
    {
        var sinceParam = Uri.EscapeDataString(since.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
        var url = $"notifications?all=true&since={sinceParam}&per_page={PerPage}";
        var (items, degraded) = await GitHubArrayReader
            .ReadAsync(_httpFactory, _readToken, url, Parse, ct, _logger, "notifications").ConfigureAwait(false);
        return new NotificationsResult(items, degraded);
    }

    // NOTE: this delegate runs inside GitHubArrayReader's guarded region, whose catch filter
    // is (HttpRequestException | JsonException | TaskCanceledException). It must not throw
    // anything else — hence int.TryParse below, NOT int.Parse (an OverflowException would
    // escape that filter and 500 /api/activity). Don't "simplify" to int.Parse. (#665)
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
        // or oversized digit run would overflow int and throw OverflowException, which
        // GitHubArrayReader's catch filter does NOT cover (only Http/Json/TaskCanceled) — it
        // would escape and 500 /api/activity, violating degrade-don't-throw. Drop instead.
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
