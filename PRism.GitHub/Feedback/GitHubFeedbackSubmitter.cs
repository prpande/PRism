using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PRism.Core.Feedback;

namespace PRism.GitHub.Feedback;

// Creates a feedback issue in the public prpande/PRism-feedback repo using the
// user's PAT. Targets api.github.com via its own named client (NOT the host-scoped
// "github" client) — the feedback repo lives on github.com unconditionally (§4.1).
// Headers inlined (plan deviation #2). No logging of PAT or GitHub bodies (Octokit
// source-hygiene): error bodies are not read on the CannotCreate path.
public sealed class GitHubFeedbackSubmitter : IFeedbackSubmitter
{
    public const string ClientName = "github.com";

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _configuredHost;

    public GitHubFeedbackSubmitter(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string configuredHost)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _configuredHost = configuredHost;
    }

    // The configured GitHub host normalizes to github.com (case-insensitive,
    // trailing slash ignored) — mirrors HostUrlResolver's own github.com test.
    private static bool IsGitHubCom(string host) =>
        Uri.TryCreate(host, UriKind.Absolute, out var u)
        && u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase);

    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "configuredHost is the raw host string from config, not a URI parameter seam.")]
    public async Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);

        // Defense-in-depth (not just the frontend gate): never read or egress the
        // user's PAT to public api.github.com when they're on a GHES host. The
        // feedback repo lives on github.com only, so a non-github.com session
        // short-circuits to CannotCreate → the frontend opens the prefilled link.
        if (!IsGitHubCom(_configuredHost))
            return FeedbackCreateResult.CannotCreate();

        var title = $"[{content.Category}] {content.Summary}";
        var body = BuildBody(content);
        var payload = JsonSerializer.Serialize(new { title, body });

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient(ClientName);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"repos/{FeedbackRepo.Slug}/issues")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);

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
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;
        var number = root.TryGetProperty("number", out var n) && n.ValueKind == JsonValueKind.Number ? n.GetInt32() : 0;
        var htmlUrl = root.TryGetProperty("html_url", out var u2) && u2.ValueKind == JsonValueKind.String ? u2.GetString() ?? "" : "";
        // Defense-in-depth: never propagate a non-https html_url to the client
        // (the frontend openExternal also guards, but don't rely on a single layer).
        if (!htmlUrl.StartsWith("https://", StringComparison.Ordinal)) htmlUrl = "";
        return FeedbackCreateResult.Created(number, htmlUrl);
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
