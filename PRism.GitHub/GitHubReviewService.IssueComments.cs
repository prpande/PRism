using System.Net;
using System.Text;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.GitHub;

// IReviewSubmitter.CreateIssueCommentAsync — REST POST /repos/{owner}/{repo}/issues/{number}/comments.
// This is a standalone issue-comment POST, distinct from the GraphQL pending-review pipeline in
// GitHubReviewService.Submit.cs. Used by the root-comment/post endpoint (Task 10).
//
// Auth/HttpClient/JSON seams: same as the other REST methods in GitHubReviewService.cs —
// _httpFactory.CreateClient("github") with the bearer token via SendGitHubAsync (which reads
// _readToken, attaches Authorization, UserAgent, Accept). The "github" named client's BaseAddress
// is `https://api.github.com/` (or the GHES equivalent); relative URLs resolve against it.
//
// Non-2xx: throws HttpRequestException with the StatusCode populated (the default from
// resp.EnsureSuccessStatusCode). Task 10 maps specific codes (403, 404, 422…) to typed error results.
public sealed partial class GitHubReviewService
{
    public async Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
        PrReference reference,
        string bodyMarkdown,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(bodyMarkdown);

        var url = $"repos/{reference.Owner}/{reference.Repo}/issues/{reference.Number}/comments";
        var payload = JsonSerializer.Serialize(new { body = bodyMarkdown });

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            // Read the body before calling EnsureSuccessStatusCode so the exception's Message
            // carries the actionable reason (same pattern as PostGraphQLAsync in the main partial).
            string errorBody = string.Empty;
            try
            {
                errorBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
#pragma warning disable CA1031
            catch (Exception)
            {
                // best-effort; original status is what matters
            }
#pragma warning restore CA1031

            throw new HttpRequestException(
                $"GitHub issue comment POST HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(errorBody, 512)}",
                inner: null,
                statusCode: resp.StatusCode);
        }

        var responseBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64()
            : throw new HttpRequestException("GitHub issue comment response missing 'id' field.",
                inner: null, statusCode: HttpStatusCode.OK);

        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : DateTimeOffset.UtcNow;

        return new CreatedIssueCommentResult(id, createdAt);
    }
}
