using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using PRism.Core.Feedback;

namespace PRism.GitHub.Feedback;

// Creates a feedback issue in the public prpande/PRism-feedback repo using the
// user's PAT. Targets api.github.com via its own named client (NOT the host-scoped
// "github" client) — the feedback repo lives on github.com unconditionally (§4.1).
// Headers go through GitHubHttp.SendAsync (#320). No logging of PAT or GitHub bodies
// (Octokit source-hygiene): error bodies are not read on the CannotCreate path.
public sealed class GitHubFeedbackSubmitter : IFeedbackSubmitter
{
    public const string ClientName = "github.com";

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string?> _readConfiguredHost;

    public GitHubFeedbackSubmitter(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string?> readConfiguredHost)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readConfiguredHost = readConfiguredHost;
    }

    // The configured GitHub host normalizes to github.com (case-insensitive,
    // trailing slash ignored) — mirrors HostUrlResolver's own github.com test.
    // Requires https scheme: http://github.com is rejected (HostUrlResolver.ApiBase
    // requires https, and a downgraded scheme could route a PAT over plain HTTP).
    private static bool IsGitHubCom(string? host) =>
        Uri.TryCreate(host, UriKind.Absolute, out var u)
        && u.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
        && u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase);

    public async Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);

        // Defense-in-depth (not just the frontend gate): never read or egress the
        // user's PAT to public api.github.com when they're on a GHES host. The
        // feedback repo lives on github.com only, so a non-github.com session
        // short-circuits to CannotCreate → the frontend opens the prefilled link.
        // Host is late-bound (read at call time, not DI construction) so a live
        // config change (github.com → GHES) takes effect immediately without restart.
        var host = _readConfiguredHost();
        if (!IsGitHubCom(host))
            return FeedbackCreateResult.CannotCreate();

        var title = $"[{content.Category}] {content.Summary}";
        var body = BuildBody(content);
        var payload = JsonSerializer.Serialize(new { title, body });

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient(ClientName);
        var url = $"repos/{FeedbackRepo.Slug}/issues";
        using var requestContent = new StringContent(payload, Encoding.UTF8, "application/json");
        using var resp = await GitHubHttp.SendAsync(
            http, HttpMethod.Post, url, token, ct, content: requestContent).ConfigureAwait(false);

        // 401 (expired/revoked PAT), 403 (scope/permission/rate-limit), 404
        // (fine-grained can't see repo), 422 (validation/missing-label) all degrade
        // to the prefilled-link fallback rather than a retry-forever 5xx.
        if (resp.StatusCode is HttpStatusCode.Unauthorized
            or HttpStatusCode.Forbidden
            or HttpStatusCode.NotFound
            or HttpStatusCode.UnprocessableEntity)
            return FeedbackCreateResult.CannotCreate();

        resp.EnsureSuccessStatusCode(); // genuine transport/5xx → throw → endpoint 500

        var responseBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            var root = doc.RootElement;
            var number = root.TryGetProperty("number", out var n) && n.ValueKind == JsonValueKind.Number ? n.GetInt32() : 0;
            // A 2xx body without a positive issue number (proxy HTML page, empty object, etc.)
            // degrades to CannotCreate so the frontend falls back to the prefilled link
            // rather than showing a success with an unusable issue-0 URL.
            if (number <= 0)
                return FeedbackCreateResult.CannotCreate();
            var htmlUrl = root.TryGetProperty("html_url", out var u2) && u2.ValueKind == JsonValueKind.String ? u2.GetString() ?? "" : "";
            // Defense-in-depth: never propagate a non-https html_url to the client
            // (the frontend openExternal also guards, but don't rely on a single layer).
            if (!htmlUrl.StartsWith("https://", StringComparison.Ordinal)) htmlUrl = "";
            return FeedbackCreateResult.Created(number, htmlUrl);
        }
        catch (JsonException)
        {
            // Non-JSON 2xx (e.g. a proxy HTML page) → fall back to prefilled link.
            return FeedbackCreateResult.CannotCreate();
        }
    }

    private static string BuildBody(FeedbackContent c)
    {
        var sb = new StringBuilder();
        sb.AppendLine(c.Details);
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine("```");
        sb.AppendLine(CultureInfo.InvariantCulture, $"route: {c.RoutePattern}");
        sb.AppendLine(CultureInfo.InvariantCulture, $"platform: {c.Platform}");
        sb.AppendLine(CultureInfo.InvariantCulture, $"version: {c.Version}");
        sb.AppendLine(CultureInfo.InvariantCulture, $"submitted: {c.SubmittedAt:O}");
        sb.AppendLine("```");
        return sb.ToString();
    }
}
