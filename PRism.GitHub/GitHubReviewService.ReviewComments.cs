using System.Text;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.GitHub;

// #302 — single-comment write path. Inline = REST POST /pulls/{n}/comments (mirrors IssueComments.cs).
// Reply = GraphQL addPullRequestReviewThreadReply with NO pullRequestReviewId (posts immediately).
public sealed partial class GitHubReviewService
{
    public async Task<CreatedReviewCommentResult> CreateReviewCommentAsync(
        PrReference reference, ReviewCommentRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(request);

        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/comments";
        var payload = JsonSerializer.Serialize(new
        {
            body = request.BodyMarkdown,
            commit_id = request.CommitOid,
            path = request.FilePath,
            line = request.LineNumber,
            side = request.Side,
        });

        using var http = _httpFactory.CreateClient("github");
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var resp = await SendGitHubAsync(http, HttpMethod.Post, url, ct,
            content: content).ConfigureAwait(false);

        if (!resp.IsSuccessStatusCode)
        {
            var errorBody = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
            throw new HttpRequestException(
                $"GitHub review comment POST HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(errorBody, 512)}",
                inner: null, statusCode: resp.StatusCode);
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64()
            : throw new GitHubRestContractException("GitHub review comment response missing 'id'.");
        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : throw new GitHubRestContractException("GitHub review comment response missing 'created_at'.");
        return new CreatedReviewCommentResult(id, createdAt);
    }

    public async Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(
        PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(parentThreadId);
        ArgumentNullException.ThrowIfNull(bodyMarkdown);

        // No pullRequestReviewId → the reply posts immediately (GitHubReviewService.Submit.cs:115-116).
        const string mutation = """
            mutation($threadId: ID!, $body: String!) {
              addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
                comment { databaseId createdAt }
              }
            }
            """;
        var data = await PostSubmitGraphQLAsync(mutation, new { threadId = parentThreadId, body = bodyMarkdown }, ct).ConfigureAwait(false);
        // databaseId is the NUMERIC REST id (not the opaque GraphQL node id) — matches CreatedReviewCommentResult.Id
        // and the inline REST method's id, so both paths yield comparable numeric ids for de-dup.
        if (!TryGetPath(data, out var dbEl, "addPullRequestReviewThreadReply", "comment", "databaseId")
            || dbEl.ValueKind != JsonValueKind.Number)
            throw new GitHubGraphQLException("addPullRequestReviewThreadReply response missing comment.databaseId.");
        // CreatedAt is advisory (callers de-dup on the numeric Id, not the timestamp); a default when the
        // selection unexpectedly omits createdAt is survivable — mirrors the GraphQL createdAt handling in Submit.cs.
        var createdAt = TryGetPath(data, out var caEl, "addPullRequestReviewThreadReply", "comment", "createdAt") && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : default;
        return new CreatedReviewCommentResult(dbEl.GetInt64(), createdAt);
    }
}
