using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

// Fault-isolated received_events reader. Mirrors GitHubCiFailingDetector:
// degrade-don't-throw on ANY non-success / transport failure (CI/feed enrichment
// must never break the surface). No 429 rethrow here — unlike the inbox poller,
// the activity endpoint has no orchestrator backoff loop, so a 429 simply degrades.
public sealed class GitHubReceivedEventsReader : IReceivedEventsReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<Task<string?>> _readLogin;

    public GitHubReceivedEventsReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<Task<string?>> readLogin)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readLogin = readLogin;
    }

    public async Task<ReceivedEventsResult> ReadAsync(CancellationToken ct)
    {
        // Empty-login short-circuits before any HTTP — a caller concern, not a transport
        // fault, so it stays outside the shared guarded region.
        var login = await _readLogin().ConfigureAwait(false);
        if (string.IsNullOrEmpty(login))
            return new ReceivedEventsResult([], Degraded: true);

        var url = $"users/{Uri.EscapeDataString(login)}/received_events?per_page={PerPage}";
        var (items, degraded) = await GitHubArrayReader
            .ReadAsync(_httpFactory, _readToken, url, Parse, ct).ConfigureAwait(false);
        return new ReceivedEventsResult(items, degraded);
    }

    private static RawReceivedEvent? Parse(JsonElement el)
    {
        if (!el.TryGetProperty("id", out var idEl) || !el.TryGetProperty("type", out var typeEl))
            return null;
        var id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.GetRawText();
        var type = typeEl.GetString();
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(type)) return null;

        string? actorLogin = null, actorAvatar = null;
        if (el.TryGetProperty("actor", out var actor) && actor.ValueKind == JsonValueKind.Object)
        {
            actorLogin = actor.TryGetProperty("login", out var l) ? l.GetString() : null;
            actorAvatar = actor.TryGetProperty("avatar_url", out var a) ? a.GetString() : null;
        }

        var repo = el.TryGetProperty("repo", out var r) && r.TryGetProperty("name", out var rn)
            ? rn.GetString() ?? "" : "";

        string? action = null;
        int? prNumber = null;
        string? title = null, htmlUrl = null;
        var merged = false;
        var isPrComment = false;
        JsonElement prMarker = default;

        if (el.TryGetProperty("payload", out var p) && p.ValueKind == JsonValueKind.Object)
        {
            action = p.TryGetProperty("action", out var ac) ? ac.GetString() : null;

            if (p.TryGetProperty("pull_request", out var pr) && pr.ValueKind == JsonValueKind.Object)
            {
                if (pr.TryGetProperty("number", out var n) && n.TryGetInt32(out var num)) prNumber = num;
                title = pr.TryGetProperty("title", out var t) ? t.GetString() : null;
                htmlUrl = pr.TryGetProperty("html_url", out var u) ? u.GetString() : null;
                merged = pr.TryGetProperty("merged", out var m) && m.ValueKind == JsonValueKind.True;
            }
            else if (p.TryGetProperty("issue", out var issue) && issue.ValueKind == JsonValueKind.Object)
            {
                isPrComment = issue.TryGetProperty("pull_request", out prMarker)
                    && prMarker.ValueKind == JsonValueKind.Object;
                if (issue.TryGetProperty("number", out var n) && n.TryGetInt32(out var num)) prNumber = num;
                title = issue.TryGetProperty("title", out var t) ? t.GetString() : null;
                // CRITICAL: an IssueCommentEvent on a PR carries issue.html_url = ".../issues/N"
                // (the issues view), while the real PR web URL ".../pull/N" lives ONLY in
                // issue.pull_request.html_url. Use the PR url for PR comments so the in-app
                // /pr/ link parser (Task 8.3) matches; fall back to issue.html_url otherwise.
                htmlUrl = (isPrComment && prMarker.TryGetProperty("html_url", out var prHtml))
                    ? prHtml.GetString()
                    : (issue.TryGetProperty("html_url", out var u) ? u.GetString() : null);
            }
        }

        var createdAt = el.TryGetProperty("created_at", out var ca)
            && ca.TryGetDateTimeOffset(out var dto) ? dto : default;

        return new RawReceivedEvent(id, type, actorLogin, actorAvatar, repo, action,
            prNumber, title, htmlUrl, merged, isPrComment, createdAt);
    }
}
