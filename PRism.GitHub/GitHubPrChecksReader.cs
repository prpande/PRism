// PRism.GitHub/GitHubPrChecksReader.cs
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Inbox;

namespace PRism.GitHub;

public sealed class GitHubPrChecksReader : IPrChecksReader
{
    // Defensive page cap — 10 * per_page=100 = 1,000 entries, well above any realistic matrix.
    private const int MaxPages = 10;

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubPrChecksReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<ChecksResponseDto> ReadAsync(PrReference pr, string headSha, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(pr);
        var token = await _readToken().ConfigureAwait(false);

        var (runs, runsDegraded) = await ReadCheckRunsAsync(pr, headSha, token, ct).ConfigureAwait(false);
        var (statuses, statusDegraded) = await ReadStatusesAsync(pr, headSha, token, ct).ConfigureAwait(false);

        var checks = new List<CheckDto>(runs.Count + statuses.Count);
        checks.AddRange(runs);
        checks.AddRange(statuses);

        return new ChecksResponseDto(checks, headSha, Worse(runsDegraded, statusDegraded));
    }

    // Auth before Transient; None only when both clean.
    private static DegradedReason Worse(DegradedReason a, DegradedReason b)
    {
        if (a == DegradedReason.Auth || b == DegradedReason.Auth) return DegradedReason.Auth;
        if (a == DegradedReason.Transient || b == DegradedReason.Transient) return DegradedReason.Transient;
        return DegradedReason.None;
    }

    private async Task<(List<CheckDto> Checks, DegradedReason Degraded)> ReadCheckRunsAsync(
        PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var checks = new List<CheckDto>();
        string? nextUrl = null;
        var initial = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/check-runs?per_page=100";

        for (var page = 0; page < MaxPages; page++)
        {
            using var resp = await SendAsync(nextUrl ?? initial, token, ct).ConfigureAwait(false);
            if (resp.StatusCode == HttpStatusCode.NotFound) return (checks, DegradedReason.None);
            GitHubHttp.ThrowIfRateLimited(resp);
            if (!resp.IsSuccessStatusCode) return (checks, DegradedFor(resp));

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("check_runs", out var runs)) break;

            foreach (var r in runs.EnumerateArray())
            {
                var (status, conclusion) = GitHubCheckClassifier.ClassifyCheckRun(r);
                checks.Add(new CheckDto(
                    Name: r.TryGetProperty("name", out var nm) ? nm.GetString() ?? "" : "",
                    Status: status,
                    Conclusion: conclusion,
                    Source: "check-run",
                    StartedAt: ParseTime(r, "started_at"),
                    CompletedAt: ParseTime(r, "completed_at"),
                    DetailsUrl: SanitizeUrl(StringProp(r, "details_url") ?? StringProp(r, "html_url")),
                    Summary: NestedStringProp(r, "output", "title"),
                    Body: NestedStringProp(r, "output", "summary") ?? NestedStringProp(r, "output", "text"),
                    AppName: NestedStringProp(r, "app", "name")));
            }

            nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var n) ? n : null;
            if (nextUrl is null) break;
        }

        return (checks, DegradedReason.None);
    }

    private async Task<(List<CheckDto> Checks, DegradedReason Degraded)> ReadStatusesAsync(
        PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var checks = new List<CheckDto>();
        string? nextUrl = null;
        var initial = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/status?per_page=100";

        // The combined-status endpoint (singular /status) DOES paginate: it accepts
        // per_page/page and emits Link rel=next when a commit has >100 contexts (GitHub
        // returns the most recent status per context, up to 100 per page). The walk is
        // intentional, not dead code — it mirrors the /check-runs walk above.
        for (var page = 0; page < MaxPages; page++)
        {
            using var resp = await SendAsync(nextUrl ?? initial, token, ct).ConfigureAwait(false);
            if (resp.StatusCode == HttpStatusCode.NotFound) return (checks, DegradedReason.None);
            GitHubHttp.ThrowIfRateLimited(resp);
            if (!resp.IsSuccessStatusCode) return (checks, DegradedFor(resp));

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            // #286: a bare-pending payload with no registered contexts contributes no CheckDto.
            if (GitHubCheckClassifier.HasRegisteredStatuses(root)
                && root.TryGetProperty("statuses", out var statuses)
                && statuses.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in statuses.EnumerateArray())
                {
                    var (status, conclusion) = GitHubCheckClassifier.ClassifyStatusContext(s);
                    checks.Add(new CheckDto(
                        Name: StringProp(s, "context") ?? "",
                        Status: status,
                        Conclusion: conclusion,
                        Source: "status",
                        StartedAt: null,
                        CompletedAt: null,
                        DetailsUrl: SanitizeUrl(StringProp(s, "target_url")),
                        Summary: StringProp(s, "description"),
                        Body: null, // legacy status has no output body
                        AppName: null)); // legacy status has no app object; the context name is the source
                }
            }

            nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var n) ? n : null;
            if (nextUrl is null) break;
        }

        return (checks, DegradedReason.None);
    }

    // 401 (bad/expired credentials) and 403 (insufficient scope) both mean the token,
    // not the network, is the problem — surface the auth-specific banner. Everything else
    // (5xx, 429-after-rate-limit-throw, etc.) is transient.
    private static DegradedReason DegradedFor(HttpResponseMessage resp) =>
        resp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized
            ? DegradedReason.Auth
            : DegradedReason.Transient;

    private static string? StringProp(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

    // Reads el[outer][inner] as a string; null if either level is absent/null/non-object.
    // Used for check-run output.title and app.name (both nested one level deep).
    private static string? NestedStringProp(JsonElement el, string outer, string inner) =>
        el.TryGetProperty(outer, out var o) && o.ValueKind == JsonValueKind.Object
            ? StringProp(o, inner)
            : null;

    private static DateTimeOffset? ParseTime(JsonElement el, string name) =>
        StringProp(el, name) is { } s && DateTimeOffset.TryParse(s, out var t) ? t : null;

    // https-only allowlist (NOT StartsWith — bypassable). GitHub html_url is always https.
    private static string? SanitizeUrl(string? raw) =>
        raw is not null && Uri.TryCreate(raw, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps
            ? raw
            : null;

    private async Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
    {
        using var http = _httpFactory.CreateClient("github");
        return await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
    }
}
