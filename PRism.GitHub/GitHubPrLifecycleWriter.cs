using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

// #566 IPrLifecycleWriter — REST close/reopen + GraphQL draft toggles. Transport rides the
// shared statics via the thin wrappers below (verbatim twins of GitHubReviewSubmitter's), and
// failures are classified into PrLifecycleErrorCode on the response body (NOT the bare status),
// per the spec's error-handling section. internal sealed; constructed via DI + the test factory.
internal sealed partial class GitHubPrLifecycleWriter : IPrLifecycleWriter
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubPrLifecycleWriter> _log;

    public GitHubPrLifecycleWriter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string host,
        ILogger<GitHubPrLifecycleWriter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubPrLifecycleWriter>.Instance;
    }

    public Task<PrLifecycleResult> CloseAsync(PrReference reference, CancellationToken ct) =>
        PatchStateAsync(reference, "closed", ct);

    public Task<PrLifecycleResult> ReopenAsync(PrReference reference, CancellationToken ct) =>
        PatchStateAsync(reference, "open", ct);

    public Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference reference, CancellationToken ct) =>
        RunDraftMutationAsync(reference, "markPullRequestReadyForReview", ct);

    public Task<PrLifecycleResult> ConvertToDraftAsync(PrReference reference, CancellationToken ct) =>
        RunDraftMutationAsync(reference, "convertPullRequestToDraft", ct);

    // ---- REST close/reopen ----
    private async Task<PrLifecycleResult> PatchStateAsync(PrReference reference, string state, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}";
        using var content = new StringContent($"{{\"state\":\"{state}\"}}", Encoding.UTF8, "application/json");
        using var http = _httpFactory.CreateClient("github");
        var token = await _readToken().ConfigureAwait(false);
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Patch, url, token, ct, content).ConfigureAwait(false);
        if (resp.IsSuccessStatusCode) return PrLifecycleResult.Ok;

        var body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
        var code = ClassifyRestFailure(resp.StatusCode, body, isReopen: state == "open");
        Log.LifecycleFailed(_log, $"{reference.Owner}/{reference.Repo}#{reference.Number}", state, (int)resp.StatusCode, GitHubHttp.Truncate(body, 1024));
        return PrLifecycleResult.Fail(code);
    }

    private static PrLifecycleErrorCode ClassifyRestFailure(HttpStatusCode status, string body, bool isReopen)
    {
        if (status == HttpStatusCode.TooManyRequests) return PrLifecycleErrorCode.RateLimited;
        if (isReopen && status == HttpStatusCode.UnprocessableEntity) return PrLifecycleErrorCode.ReopenNotPossible;
        if (status == HttpStatusCode.Forbidden)
        {
            // CORRECTED (plan ce-doc-review — adversarial): GitHub returns 403 for BOTH the
            // secondary-rate-limit/abuse family AND PRIMARY rate-limit exhaustion ("API rate
            // limit exceeded for …", X-RateLimit-Remaining: 0). Match "rate limit" broadly so a
            // rate-limited user is NOT told to fix their PAT scopes. This subsumes the secondary
            // wording.
            if (body.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
                || body.Contains("abuse", StringComparison.OrdinalIgnoreCase))
                return PrLifecycleErrorCode.RateLimited;
            if (body.Contains("Protected branch", StringComparison.OrdinalIgnoreCase)
                || body.Contains("Validation Failed", StringComparison.OrdinalIgnoreCase))
                return PrLifecycleErrorCode.RepoRuleBlocked;
            // Default 403: scope/permission denial OR non-collaborator (same body) — the FE copy covers both.
            return PrLifecycleErrorCode.TokenCannotWrite;
        }
        return PrLifecycleErrorCode.Generic;
    }

    // Map a non-2xx HTTP failure (thrown by GitHubGraphQL.PostAsync) to a code via its status.
    private static PrLifecycleErrorCode ClassifyHttpStatus(HttpStatusCode? status) => status switch
    {
        HttpStatusCode.TooManyRequests => PrLifecycleErrorCode.RateLimited,
        HttpStatusCode.Unauthorized => PrLifecycleErrorCode.TokenCannotWrite,
        HttpStatusCode.Forbidden => PrLifecycleErrorCode.TokenCannotWrite,
        _ => PrLifecycleErrorCode.Generic,
    };

    // ---- GraphQL draft toggles ----
    private async Task<PrLifecycleResult> RunDraftMutationAsync(PrReference reference, string mutation, CancellationToken ct)
    {
        var prLabel = $"{reference.Owner}/{reference.Repo}#{reference.Number}";
        string nodeId;
        try
        {
            nodeId = await ResolveNodeIdAsync(reference, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // CORRECTED (plan ce-doc-review — feasibility + adversarial): classify on status,
            // don't blanket-Generic (a 401/403/429 during resolve keeps its meaning).
            Log.LifecycleFailed(_log, prLabel, $"{mutation}:resolve", (int?)ex.StatusCode ?? 0, ex.Message);
            return PrLifecycleResult.Fail(ClassifyHttpStatus(ex.StatusCode));
        }

        var query = $$"""
            mutation($id: ID!) {
              {{mutation}}(input: { pullRequestId: $id }) {
                pullRequest { isDraft }
              }
            }
            """;
        try
        {
            // CORRECTED (plan ce-doc-review — feasibility + adversarial): GitHubGraphQL.PostAsync
            // THROWS HttpRequestException on any non-2xx (only GraphQL field-errors arrive as
            // 200 + errors[]). The mutation call MUST be wrapped or a real 401/403/429/5xx escapes
            // as an unhandled 500 instead of a typed code.
            var body = await PostGraphQLAsync(query, new { id = nodeId }, ct).ConfigureAwait(false);
            return ClassifyGraphQLResult(body, mutation, reference);
        }
        catch (HttpRequestException ex)
        {
            Log.LifecycleFailed(_log, prLabel, mutation, (int?)ex.StatusCode ?? 0, ex.Message);
            return PrLifecycleResult.Fail(ClassifyHttpStatus(ex.StatusCode));
        }
    }

    private async Task<string> ResolveNodeIdAsync(PrReference reference, CancellationToken ct)
    {
        const string query = """
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) { id }
              }
            }
            """;
        var json = await PostGraphQLAsync(query, new { owner = reference.Owner, repo = reference.Repo, number = reference.Number }, ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.TryGetProperty("data", out var data)
            && data.TryGetProperty("repository", out var repo)
            && repo.ValueKind == JsonValueKind.Object
            && repo.TryGetProperty("pullRequest", out var pr)
            && pr.ValueKind == JsonValueKind.Object
            && pr.TryGetProperty("id", out var id)
            && id.GetString() is { Length: > 0 } nodeId)
        {
            return nodeId;
        }
        throw new HttpRequestException($"No GraphQL node id for {reference.Owner}/{reference.Repo}#{reference.Number}");
    }

    private static PrLifecycleErrorCode? FirstGraphQLErrorCode(string body, string mutation)
    {
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() == 0)
            return null; // no errors
        // Inspect the first error message. "already ready"/"already a draft" → benign no-op (caller maps to Ok).
        var msg = errors[0].TryGetProperty("message", out var m) ? (m.GetString() ?? "") : "";
        if (msg.Contains("already a draft", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("already ready", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("not a draft", StringComparison.OrdinalIgnoreCase))
            return PrLifecycleErrorCode.None; // sentinel for benign
        if (mutation == "convertPullRequestToDraft"
            && (msg.Contains("draft", StringComparison.OrdinalIgnoreCase) && msg.Contains("not supported", StringComparison.OrdinalIgnoreCase)))
            return PrLifecycleErrorCode.PlanUnsupportedDrafts;
        if (errors[0].TryGetProperty("type", out var t) && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
            return PrLifecycleErrorCode.RateLimited;
        if (msg.Contains("not have permission", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("Resource not accessible", StringComparison.OrdinalIgnoreCase))
            return PrLifecycleErrorCode.TokenCannotWrite;
        return PrLifecycleErrorCode.Generic;
    }

    private PrLifecycleResult ClassifyGraphQLResult(string body, string mutation, PrReference reference)
    {
        var code = FirstGraphQLErrorCode(body, mutation);
        if (code is null) return PrLifecycleResult.Ok;                 // no errors
        if (code == PrLifecycleErrorCode.None) return PrLifecycleResult.Ok; // benign already-in-state
        Log.LifecycleFailed(_log, $"{reference.Owner}/{reference.Repo}#{reference.Number}", mutation, 200, GitHubHttp.Truncate(body, 1024));
        return PrLifecycleResult.Fail(code.Value);
    }

    // ---- transport wrappers (verbatim twins of GitHubReviewSubmitter's) ----
    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, EventId = 1, EventName = "PrLifecycleFailed",
            Message = "PR lifecycle action failed: pr={Pr} action={Action} status={Status} body={Body}")]
        internal static partial void LifecycleFailed(ILogger logger, string pr, string action, int status, string body);
    }
}
