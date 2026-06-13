using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;   // AuthValidationResult / AuthValidationError / AuthValidationWarning live here (IReviewAuth is in PRism.Core)

namespace PRism.GitHub;

// PAT auth/scope validation, relocated verbatim from GitHubReviewService (#321 PR1, epic #317).
// Implements IReviewAuth on its own instance; shares no state with the read/submit paths — it
// only reads the token, builds the named "github" client, and attaches headers via GitHubHttp.
// No logger dependency. `internal sealed` (not `public`): construction is via DI + the test
// projects (InternalsVisibleTo); callers resolve IReviewAuth, never the concrete type.
internal sealed class GitHubAuthValidator : IReviewAuth
{
    // Classic-PAT scope requirements, expressed as (capability, scopes that satisfy it).
    // GitHub reports only the literally-granted scope in X-OAuth-Scopes — a parent scope is
    // NOT expanded into its children — so any parent that supersets a requirement must be
    // listed explicitly as an accepting scope:
    //   • `repo` has no parent; only the full `repo` scope reads private PRs. Its children
    //     (`public_repo`, `repo:status`, …) are narrower and must NOT satisfy it.
    //   • `read:org` is satisfied by itself or either parent, `write:org` / `admin:org`.
    // `read:user` is intentionally absent: no PRism API call needs it (commenter avatars and
    // public profiles are returned without any user scope, and /user returns the token-holder's
    // login regardless of scope). Requiring it rejected tokens that granted the `user` parent.
    private static readonly (string Capability, string[] AcceptedBy)[] RequiredScopes =
    [
        ("repo", ["repo"]),
        ("read:org", ["read:org", "write:org", "admin:org"]),
    ];

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;

    public GitHubAuthValidator(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string host)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false)
    {
        var token = await _readToken().ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

        var tokenType = ClassifyToken(token);

        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, "user");
        GitHubHttp.ApplyHeaders(req, http, token);
        if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);

        try
        {
            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            var primary = await InterpretAsync(resp, tokenType, ct).ConfigureAwait(false);
            if (!primary.Ok || tokenType != TokenType.FineGrained) return primary;

            // Fine-grained: probe Search to detect the no-repos-selected case.
            try
            {
                var warning = await ProbeRepoVisibilityAsync(token, skipCredentialHealth, ct).ConfigureAwait(false);
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
            var granted = scopes.ToHashSet(StringComparer.Ordinal);
            // A capability is satisfied when the token grants any scope that accepts it
            // (the scope itself or one of its parents). Report the capability name — not the
            // accepting set — so the user sees what to add, e.g. "missing scopes: read:org".
            var missing = RequiredScopes
                .Where(r => !r.AcceptedBy.Any(granted.Contains))
                .Select(r => r.Capability)
                .ToArray();
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

    private async Task<AuthValidationWarning> ProbeRepoVisibilityAsync(string token, bool skipCredentialHealth, CancellationToken ct)
    {
        if (await SearchHasResultsAsync(token, "is:pr author:@me", skipCredentialHealth, ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        if (await SearchHasResultsAsync(token, "is:pr review-requested:@me", skipCredentialHealth, ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        return AuthValidationWarning.NoReposSelected;
    }

    private async Task<bool> SearchHasResultsAsync(string token, string query, bool skipCredentialHealth, CancellationToken ct)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(query)}&per_page=1";
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        GitHubHttp.ApplyHeaders(req, http, token);
        if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.TryGetProperty("total_count", out var tc)
            && tc.ValueKind == JsonValueKind.Number
            && tc.GetInt32() > 0;
    }
}
