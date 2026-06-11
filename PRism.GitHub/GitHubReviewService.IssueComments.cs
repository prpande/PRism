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
// Auth/HttpClient/JSON seams: routes through the shared SendGitHubAsync helper (main partial),
// which reads _readToken and attaches Authorization Bearer, UserAgent, Accept vnd.github+json,
// and X-GitHub-Api-Version. The JSON body is passed as the `content` argument introduced in this
// slice. The "github" named client's BaseAddress is `https://api.github.com/` (or the GHES
// equivalent); relative URLs resolve against it.
//
// Non-2xx: throws HttpRequestException with the StatusCode populated (matches PostGraphQLAsync's
// pattern of reading the response body first so the message is actionable). Task 10 maps specific
// codes (403, 404, 422…) to typed error results.
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

        using var http = _httpFactory.CreateClient("github");
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var resp = await SendGitHubAsync(
            http, HttpMethod.Post, url, ct,
            content: content).ConfigureAwait(false);

        if (!resp.IsSuccessStatusCode)
        {
            // Read the body before throwing so the exception's Message carries the actionable reason
            // (shared best-effort read; same pattern as PostGraphQLAsync in the main partial).
            var errorBody = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
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
            : throw new GitHubRestContractException("GitHub issue comment response missing 'id' field.");

        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : throw new GitHubRestContractException("GitHub issue comment response missing 'created_at'.");

        return new CreatedIssueCommentResult(id, createdAt);
    }
}
