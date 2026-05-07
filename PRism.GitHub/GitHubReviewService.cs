using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.GitHub;

public sealed class GitHubReviewService : IReviewService
{
    private static readonly string[] RequiredScopes = ["repo", "read:user", "read:org"];

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;

    public GitHubReviewService(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string host)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

        var tokenType = ClassifyToken(token);

        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, "user");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        try
        {
            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            var primary = await InterpretAsync(resp, tokenType, ct).ConfigureAwait(false);
            if (!primary.Ok || tokenType != TokenType.FineGrained) return primary;

            // Fine-grained: probe Search to detect the no-repos-selected case.
            try
            {
                var warning = await ProbeRepoVisibilityAsync(token, ct).ConfigureAwait(false);
                return primary with { Warning = warning };
            }
            catch (HttpRequestException ex) when (ex.StatusCode is { } c && (int)c >= 500)
            {
                throw;  // let the outer 5xx catch surface it as ServerError per spec
            }
            catch (HttpRequestException)
            {
                // Probe failed for a non-5xx reason (403/422/transport). The token auth itself
                // succeeded — fail open so a probe anomaly doesn't reject a valid token.
                return primary;
            }
            catch (JsonException)
            {
                // Probe returned 200 with non-JSON body (captive portal, broken proxy). Same
                // fail-open intent as the non-5xx HttpRequestException case above — primary
                // auth already succeeded; don't reject a valid token over a probe anomaly.
                return primary;
            }
        }
        catch (HttpRequestException ex) when (ex.StatusCode is { } code && (int)code >= 500)
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)code}.");
        }
        catch (HttpRequestException ex) when (IsDnsFailure(ex))
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.DnsError, $"Couldn't reach {_host}.");
        }
        catch (HttpRequestException ex)
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, ex.Message);
        }
    }

    private enum TokenType { Classic, FineGrained }

    // PRism only supports user PATs for the PoC: classic (ghp_…) and fine-grained (github_pat_…).
    // Any other prefix (gho_, ghs_, ghr_, legacy hex) routes through FineGrained, which is the
    // most permissive: no X-OAuth-Scopes check, so a non-classic token never trips
    // InsufficientScopes spuriously. App-token shapes are not officially supported as auth
    // in PoC; this classification is a "fail safely" default rather than affirmative support.
    private static TokenType ClassifyToken(string token) =>
        token.StartsWith("ghp_", StringComparison.Ordinal) ? TokenType.Classic : TokenType.FineGrained;

    private static bool IsDnsFailure(HttpRequestException ex)
    {
        if (ex.InnerException is SocketException se)
        {
            return se.SocketErrorCode == SocketError.HostNotFound
                || ex.Message.Contains("Name or service not known", StringComparison.OrdinalIgnoreCase)
                || ex.Message.Contains("No such host", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    private static async Task<AuthValidationResult> InterpretAsync(HttpResponseMessage resp, TokenType tokenType, CancellationToken ct)
    {
        if (resp.StatusCode == HttpStatusCode.Unauthorized)
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.");

        if ((int)resp.StatusCode >= 500)
            return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)resp.StatusCode}.");

        if (!resp.IsSuccessStatusCode)
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, $"unexpected status {(int)resp.StatusCode}");

        var scopesHeader = resp.Headers.TryGetValues("X-OAuth-Scopes", out var values) ? string.Join(",", values) : "";
        var scopes = scopesHeader.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (tokenType == TokenType.Classic)
        {
            var missing = RequiredScopes.Except(scopes).ToArray();
            if (missing.Length > 0)
                return new AuthValidationResult(false, null, scopes, AuthValidationError.InsufficientScopes,
                    $"missing scopes: {string.Join(", ", missing)}");
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        string? login;
        try
        {
            using var doc = JsonDocument.Parse(body);
            login = doc.RootElement.TryGetProperty("login", out var l) ? l.GetString() : null;
        }
        catch (JsonException)
        {
            // GitHub-side intermediaries (proxy, captive portal, GHES misconfig) can return
            // 200 with HTML or otherwise malformed JSON. Surface as ServerError, not 500.
            return new AuthValidationResult(false, null, scopes, AuthValidationError.ServerError,
                "GitHub returned an unparseable response body.");
        }

        if (string.IsNullOrEmpty(login))
        {
            // 200 with valid JSON but no `login` field — same shape as the JsonException path
            // above (an intermediary stripped or rewrote the body). Treating this as Ok=true
            // would commit a token but leave IViewerLoginProvider empty, breaking the
            // awaiting-author inbox section.
            return new AuthValidationResult(false, null, scopes, AuthValidationError.ServerError,
                "GitHub returned a response with no login field.");
        }

        return new AuthValidationResult(true, login, scopes, AuthValidationError.None, null);
    }

    private async Task<AuthValidationWarning> ProbeRepoVisibilityAsync(string token, CancellationToken ct)
    {
        if (await SearchHasResultsAsync(token, "is:pr author:@me", ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        if (await SearchHasResultsAsync(token, "is:pr review-requested:@me", ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        return AuthValidationWarning.NoReposSelected;
    }

    private async Task<bool> SearchHasResultsAsync(string token, string query, CancellationToken ct)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(query)}&per_page=1";
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.TryGetProperty("total_count", out var tc)
            && tc.ValueKind == JsonValueKind.Number
            && tc.GetInt32() > 0;
    }

    // Stubs for methods that land in later slices.
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => throw new NotImplementedException("Inbox lands in S2.");
    public bool TryParsePrUrl(string url, out PrReference? reference)
    {
        reference = null;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (!Uri.TryCreate(_host, UriKind.Absolute, out var h)) return false;
        if (!string.Equals(u.Scheme, h.Scheme, StringComparison.OrdinalIgnoreCase)) return false;
        if (!string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase)) return false;

        var segs = u.AbsolutePath.Trim('/').Split('/');
        if (segs.Length < 4) return false;
        if (!string.Equals(segs[2], "pull", StringComparison.Ordinal)) return false;
        if (!int.TryParse(segs[3], out var n) || n <= 0) return false;

        reference = new PrReference(segs[0], segs[1], n);
        return true;
    }
    // Legacy S0+S1 surface — unused; retained for the S5 capability split per ADR-S5-1.
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Replaced by GetPrDetailAsync in S3.");
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Replaced by IterationDto inside PrDetailDto in S3.");
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException("Replaced by GetDiffAsync(prRef, DiffRangeRequest) overload in S3.");
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Replaced by IssueCommentDto/ReviewThreadDto inside PrDetailDto in S3.");

    // S3 PR detail surface — implementations land in this same PR (Task 3.4 onward).
    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("PR detail lands in S3 PR3 Step 3.4+.");
    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct) => throw new NotImplementedException("Diff lands in S3 PR3 Step 3.4+.");
    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Timeline lands in S3 PR3 Step 3.4+.");
    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException("File content lands in S3 PR3 Step 3.4+.");
    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Active-PR poll lands in S3 PR5 (ActivePrPoller wiring).");

    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException("Submit lands in S5.");
}
