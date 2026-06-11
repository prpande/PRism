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
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus " +
        "headRefName baseRefName headRefOid baseRefOid " +
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
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

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        private readonly string _body;
        public CapturingHandler(string body) => _body = body;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(_body) });
        }
    }

    // Pins the submit pipeline's GraphQL HTTP transport: it rides the shared PostGraphQLAsync,
    // so the Task 5 reroute (apiVersion:false) must keep the request byte-identical here.
    [Fact]
    public async Task SubmitPath_graphql_request_transport_is_unchanged()
    {
        var handler = new CapturingHandler(
            """{"data":{"submitPullRequestReview":{"pullRequestReview":{"id":"PRR_done","state":"APPROVED"}}}}""");
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");

        await svc.FinalizePendingReviewAsync(new PrReference("owner", "repo", 42), "PRR_x", SubmitEvent.Comment, CancellationToken.None);

        var req = handler.Last!;
        Assert.Equal("https://api.github.com/graphql", req.RequestUri!.ToString());
        Assert.Equal("PRism/0.1", req.Headers.UserAgent.ToString());
        Assert.Contains("application/vnd.github+json", req.Headers.Accept.ToString(), StringComparison.Ordinal);
        Assert.False(req.Headers.Contains("X-GitHub-Api-Version")); // GraphQL POST never sends the REST version header
        Assert.Equal("ghp_test", req.Headers.Authorization!.Parameter);
    }
}
