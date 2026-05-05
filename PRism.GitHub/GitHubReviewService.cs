using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

public sealed class GitHubReviewService : IReviewService
{
    private static readonly string[] RequiredScopes = ["repo", "read:user", "read:org"];

    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;

    public GitHubReviewService(HttpClient http, Func<Task<string?>> readToken, string host)
    {
        _http = http;
        _readToken = readToken;
        _host = host;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

        using var req = new HttpRequestMessage(HttpMethod.Get, "user");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        try
        {
            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            return await InterpretAsync(resp, ct).ConfigureAwait(false);
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

    private static async Task<AuthValidationResult> InterpretAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        if (resp.StatusCode == HttpStatusCode.Unauthorized)
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.");

        if ((int)resp.StatusCode >= 500)
            return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)resp.StatusCode}.");

        if (!resp.IsSuccessStatusCode)
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, $"unexpected status {(int)resp.StatusCode}");

        var scopesHeader = resp.Headers.TryGetValues("X-OAuth-Scopes", out var values) ? string.Join(",", values) : "";
        var scopes = scopesHeader.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var missing = RequiredScopes.Except(scopes).ToArray();
        if (missing.Length > 0)
            return new AuthValidationResult(false, null, scopes, AuthValidationError.InsufficientScopes,
                $"missing scopes: {string.Join(", ", missing)}");

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

        return new AuthValidationResult(true, login, scopes, AuthValidationError.None, null);
    }

    // Stubs for methods that land in later slices.
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => throw new NotImplementedException("Inbox lands in S2.");
    public bool TryParsePrUrl(string url, out PrReference? reference)
    {
        reference = null;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != "https" && u.Scheme != "http") return false;

        if (!Uri.TryCreate(_host, UriKind.Absolute, out var h)) return false;
        if (!string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase)) return false;

        var segs = u.AbsolutePath.Trim('/').Split('/');
        if (segs.Length < 4) return false;
        if (!string.Equals(segs[2], "pull", StringComparison.Ordinal)) return false;
        if (!int.TryParse(segs[3], out var n) || n <= 0) return false;

        reference = new PrReference(segs[0], segs[1], n);
        return true;
    }
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("PR detail lands in S3.");
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Iterations land in S3.");
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException("Diff lands in S3.");
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Comments land in S3.");
    public Task<string> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException("File content lands in S3.");
    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException("Submit lands in S5.");
}
