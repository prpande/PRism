using System.Text.Json;
using Microsoft.Extensions.Logging;
using PRism.Core.Inbox;

namespace PRism.GitHub;

// #321 PR2 — the shared raw GraphQL transport, extracted from
// GitHubReviewService.PostGraphQLAsync so the reader (IPrReader/IPrDiscovery) and the
// split-out GitHubReviewSubmitter (IReviewSubmitter) both POST through one provably-
// identical function. Static + takes the resolved (http, token, host, log) so each caller
// keeps its own token-read cadence — the #320 pattern. The request stays byte-identical to
// the pre-split form (same endpoint resolution, apiVersion:false, StringContent), which is
// the B2 submit-transport contract pinned by GraphQlByteIdentityTests + the integration
// shape-drift test.
// `partial` is required at the class level because of the nested source-gen `partial class Log`.
internal static partial class GitHubGraphQL
{
    // Raw GraphQL POST: resolves the host's GraphQL endpoint, sends apiVersion:false,
    // logs transport failures (EventId 5), throws HttpRequestException on non-2xx.
    // Returns the raw JSON body. MUST send via GitHubHttp.SendAsync so the same-host
    // PAT credential guard (GitHubHttp.ApplyHeaders) stays in the call chain.
    internal static async Task<string> PostAsync(
        HttpClient http, string? token, string host, ILogger log,
        string query, object variables, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new { query, variables });
        // Absolute URL to defeat the named client's BaseAddress = `<host>/api/v3/`. GHES's
        // GraphQL endpoint is `<host>/api/graphql` (no /v3); resolving against BaseAddress
        // would 404 on every GraphQL call against GHES.
        var endpoint = HostUrlResolver.GraphQlEndpoint(host);
        // apiVersion:false — the REST version header is meaningless to the GraphQL endpoint;
        // suppressing it keeps this request byte-identical to its pre-#320 form. The submit
        // pipeline rides this method, so byte-identity here preserves the B2 submit transport.
        using var content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
        using var resp = await GitHubHttp.SendAsync(
            http, HttpMethod.Post, endpoint.ToString(), token, ct,
            content: content, apiVersion: false).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            // GitHub's error body carries the actionable reason ({"message":"Bad credentials",…}
            // for 401, abuse/rate-limit details for 403, etc.); read it (best-effort) so the
            // exception message and the transport-failure log include it.
            string body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
            Log.GraphQLTransportFailed(log, (int)resp.StatusCode, resp.ReasonPhrase ?? "", GitHubHttp.Truncate(body, 1024));
            throw new HttpRequestException(
                $"GitHub GraphQL HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {GitHubHttp.Truncate(body, 512)}",
                inner: null,
                statusCode: resp.StatusCode);
        }
        return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    // Throws RateLimitExceededException on a 200 body carrying errors[].type == "RATE_LIMITED".
    // (HTTP 429 is surfaced by PostAsync as HttpRequestException with StatusCode 429 — callers
    // translate that to RateLimitExceededException at their catch site.) Extracted from
    // GitHubPrBatchReader.HasRateLimitError so both batch readers share one rate-limit model
    // instead of forking it. `internal` to match the enclosing `internal static` class.
    internal static void ThrowIfRateLimited(JsonElement root, string context)
    {
        if (!root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array) return;
        foreach (var e in errors.EnumerateArray())
            if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("type", out var t)
                && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
                throw new RateLimitExceededException($"GitHub GraphQL rate limit (200/RATE_LIMITED) during {context}.", retryAfter: null);
    }

    // Walks a chain of property names defensively. Returns false on any missing key,
    // any non-object intermediate, or short-circuits at the first JSON null. Shared by the
    // reader read path and all submit methods (moved out of GitHubReviewService in PR2).
    internal static bool TryGetPath(JsonElement root, out JsonElement leaf, params string[] path)
    {
        var current = root;
        foreach (var key in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(key, out var next))
            {
                leaf = default;
                return false;
            }
            current = next;
        }
        leaf = current;
        return true;
    }

    private static partial class Log
    {
        // Transport-level failures are logged at Warning because rate-limits and auth
        // expiry are recoverable conditions. Body is truncated to 1024 chars in the log so a
        // pathological 5xx body doesn't bloat the log file; the response code + first 512
        // chars in the exception's Message are what callers surface. EventId 5 preserved from
        // the pre-PR2 GitHubReviewService field (operators grep on it); after the split the
        // event surfaces under whichever ILogger category the caller passes (reader or
        // submitter) — see spec § Logging convergence (accepted consequence).
        [LoggerMessage(Level = LogLevel.Warning, EventId = 5, EventName = "GraphQLTransportFailed",
            Message = "GraphQL HTTP request failed: {StatusCode} {ReasonPhrase}. Body: {Body}")]
        internal static partial void GraphQLTransportFailed(ILogger logger, int statusCode, string reasonPhrase, string body);
    }
}
