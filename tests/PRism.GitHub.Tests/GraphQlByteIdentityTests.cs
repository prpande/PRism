using System.Net;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

// #320 — pins the EXACT current GraphQL query strings and the submit-path request transport
// BEFORE the transport refactor, so the call-site migrations cannot drift them. AC #4 + the
// round-2 B2 finding (the submit path's HTTP send is the shared PostGraphQLAsync).
public class GraphQlByteIdentityTests
{
    private const string ExpectedPrDetail =
        "query($owner:String!,$repo:String!,$number:Int!){" +
        "viewer{login} " +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus reviewDecision updatedAt " +
        "headRefName baseRefName headRefOid baseRefOid " +
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
        "reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}" +
        // #593 — avatarUrl on latestReviews + the reviewRequests connection feed the readiness popover.
        "latestReviews(first:100){nodes{author{login avatarUrl} state}}" +
        "reviewRequests(first:20){nodes{requestedReviewer{... on User{login avatarUrl} ... on Team{name}}}}" +
        "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
        "pageInfo{hasNextPage endCursor} nodes{__typename " +
        "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
        "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
        "... on PullRequestReview{submittedAt}" +
        "}}" +
        "}}}";

    [Fact]
    public void PrDetailGraphQLQuery_is_byte_identical()
        => Assert.Equal(ExpectedPrDetail, GitHubReviewService.PrDetailGraphQLQuery);

    private const string ExpectedTimeline =
        "query($owner:String!,$repo:String!,$number:Int!){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "comments(first:100){nodes{author{login} createdAt}}" +
        "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
        "nodes{__typename " +
        "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
        "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
        "... on PullRequestReview{submittedAt}" +
        "}}" +
        "}}}";

    [Fact]
    public void TimelineQuery_is_byte_identical()
        => Assert.Equal(ExpectedTimeline, GitHubReviewService.TimelineQuery);

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        public string? LastBody;
        public string? LastContentType;
        private readonly string _body;
        public CapturingHandler(string body) => _body = body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            // Read the request body HERE, inside the handler — GitHubHttp.SendAsync disposes the
            // request (and its Content) when its frame unwinds, so reading req.Content after the
            // await returns to the test would throw on disposed content.
            LastContentType = request.Content?.Headers.ContentType?.ToString();
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(_body) };
        }
    }

    // #321 PR2 B2 ground truth — captured from the PRE-move tree (plan Task 0) against the
    // unmodified GitHubReviewService transport. The post-move submit path (now GitHubGraphQL.PostAsync
    // via GitHubReviewSubmitter) MUST serialize the FinalizePendingReview {query,variables} payload
    // byte-identically to this. Do NOT regenerate this from post-move output (that would lock in a
    // drift); the only legitimate way to change it is re-running Task 0 against origin/main.
    private const string PreMoveSubmitBody =
        """{"query":"mutation($prReviewId: ID!, $event: PullRequestReviewEvent!) {\n  submitPullRequestReview(input: { pullRequestReviewId: $prReviewId, event: $event }) {\n    pullRequestReview { id state }\n  }\n}","variables":{"prReviewId":"PRR_x","event":"COMMENT"}}""";

    // Pins the submit pipeline's GraphQL HTTP transport: it rides the shared GitHubGraphQL.PostAsync,
    // so the #321 PR2 transport extraction must keep the request byte-identical here — headers, URI,
    // AND body (the body assert is the only guard on the submit request payload; the integration
    // shape-drift suite covers the read side only).
    [Fact]
    public async Task SubmitPath_graphql_request_transport_is_unchanged()
    {
        var handler = new CapturingHandler(
            """{"data":{"submitPullRequestReview":{"pullRequestReview":{"id":"PRR_done","state":"APPROVED"}}}}""");
        var svc = GitHubReviewServiceFactory.CreateSubmitter(handler);

        await svc.FinalizePendingReviewAsync(new PrReference("owner", "repo", 42), "PRR_x", SubmitEvent.Comment, CancellationToken.None);

        var req = handler.Last!;
        Assert.Equal("https://api.github.com/graphql", req.RequestUri!.ToString());
        Assert.Equal("PRism/0.1", req.Headers.UserAgent.ToString());
        Assert.Contains("application/vnd.github+json", req.Headers.Accept.ToString(), StringComparison.Ordinal);
        Assert.False(req.Headers.Contains("X-GitHub-Api-Version")); // GraphQL POST never sends the REST version header
        Assert.Equal("ghp_test", req.Headers.Authorization!.Parameter);
        // Body byte-identity against the Task 0 pre-move ground truth (the B2 contract).
        Assert.Equal("application/json; charset=utf-8", handler.LastContentType);
        Assert.Equal(PreMoveSubmitBody, handler.LastBody);
    }
}
