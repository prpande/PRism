using System.Net;
using System.Net.Http.Headers;
using PRism.Core.Inbox; // RateLimitExceededException

namespace PRism.GitHub;

// #320 — single home for GitHub HTTP request plumbing. Replaces the header set,
// 429 throw, and best-effort error-body read that were hand-copied across 10 classes.
// Static + takes the already-resolved token so each caller keeps its own token-read
// cadence (some read once per batch, some per request); the helper holds no state.
internal static class GitHubHttp
{
    internal const string UserAgent = "PRism/0.1";
    internal const string AcceptJson = "application/vnd.github+json";
    internal const string ApiVersion = "2022-11-28";

    // Inter-batch concurrency cap for per-commit / per-PR fan-out (was declared 4×).
    internal const int ConcurrencyCap = 8;

    // Applies the standard GitHub header set to an existing request. Exposed (vs. only
    // SendAsync) so callers that must set request Options (e.g. the credential-health
    // skip flag) can build their own request and still single-source the headers.
    // Same-host credential guard: the Bearer token is attached only when the request URL
    // is relative (resolved against the trusted BaseAddress) or its host+port equals the
    // client's BaseAddress — an off-host absolute URL throws HttpRequestException so the
    // PAT never rides a request to an unexpected host. HttpRequestException (not
    // ArgumentException) is deliberate: paginating callers already degrade on it.
    internal static void ApplyHeaders(
        HttpRequestMessage req, HttpClient http, string? token,
        string? accept = null, bool apiVersion = true)
    {
        if (!string.IsNullOrEmpty(token))
        {
            // Fail CLOSED: a credentialed request must have a URI we can validate.
            var uri = req.RequestUri
                ?? throw new HttpRequestException("Cannot attach GitHub credentials to a request with no RequestUri.");
            if (uri.IsAbsoluteUri)
            {
                if (http.BaseAddress is null)
                    throw new HttpRequestException(
                        "Cannot attach GitHub credentials: the HttpClient has no BaseAddress to validate the request host against.");
                // Compare host AND port. Uri.Host strips the port, so a crafted `host:8080`
                // Link URL — or an http:// downgrade (default port 80 vs the https
                // BaseAddress's 443) — must be caught here, not just a different hostname.
                if (!uri.Host.Equals(http.BaseAddress.Host, StringComparison.OrdinalIgnoreCase)
                    || uri.Port != http.BaseAddress.Port)
                {
                    throw new HttpRequestException(
                        $"Refusing to attach GitHub credentials to off-host URL (request authority '{uri.Authority}', client authority '{http.BaseAddress.Authority}').");
                }
            }
            // A relative URI resolves against the trusted BaseAddress — safe to credential.
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        req.Headers.UserAgent.ParseAdd(UserAgent);
        req.Headers.Accept.ParseAdd(accept ?? AcceptJson);
        if (apiVersion)
            req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", ApiVersion);
    }

    // Builds the request, applies the standard headers, attaches optional content, sends.
    // `accept` overrides AcceptJson; `apiVersion:false` suppresses the version header
    // (GraphQL POSTs, which the REST version header does not apply to). The caller owns
    // disposal of the returned response (matches the previous SendGitHubAsync contract).
    internal static async Task<HttpResponseMessage> SendAsync(
        HttpClient http, HttpMethod method, string url, string? token, CancellationToken ct,
        HttpContent? content = null, string? accept = null, bool apiVersion = true)
    {
        using var req = new HttpRequestMessage(method, url);
        ApplyHeaders(req, http, token, accept, apiVersion);
        if (content is not null) req.Content = content;
        return await http.SendAsync(req, ct).ConfigureAwait(false);
    }

    // Replaces the 5 inline 429 blocks. `subject` preserves each site's message exactly:
    // " Search API" for the search-section caller, "" for the other four.
    internal static void ThrowIfRateLimited(HttpResponseMessage resp, string subject = "")
    {
        if (resp.StatusCode == HttpStatusCode.TooManyRequests)
            throw new RateLimitExceededException(
                $"GitHub{subject} rate-limited (429); orchestrator should skip this tick.",
                resp.Headers.RetryAfter?.Delta);
    }

    // The ONE audited CA1031-suppressed best-effort error-body read. Returns the body,
    // or "" on a non-cancellation read failure. OperationCanceledException propagates
    // (caller shutdown), matching the existing convention.
    internal static async Task<string> ReadErrorBodyBestEffortAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        try
        {
            return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // best-effort; the original status is what matters
        catch (Exception)
        {
            return string.Empty;
        }
#pragma warning restore CA1031
    }
}
