using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitBeginTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    private const string NodeIdResponse = """{"data":{"repository":{"pullRequest":{"id":"PR_node_xyz"}}}}""";

    [Fact]
    public async Task BeginPendingReviewAsync_PostsAddPullRequestReviewMutation_WithPrNodeId_CommitOid_AndBody()
    {
        var handler = new RecordingHttpMessageHandler(new[]
        {
            (HttpStatusCode.OK, NodeIdResponse),
            (HttpStatusCode.OK, """{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_kwDOABCD123"}}}}"""),
        });
        var svc = NewService(handler);

        var result = await svc.BeginPendingReviewAsync(Ref, "abc1234", "Summary body", CancellationToken.None);

        result.PullRequestReviewId.Should().Be("PRR_kwDOABCD123");
        handler.RequestCount.Should().Be(2);

        // Request 1 resolves the PR node ID.
        using (var doc0 = JsonDocument.Parse(handler.RequestBodies[0]!))
        {
            doc0.RootElement.GetProperty("query").GetString().Should().Contain("pullRequest(number:");
            var vars0 = doc0.RootElement.GetProperty("variables");
            vars0.GetProperty("owner").GetString().Should().Be("owner");
            vars0.GetProperty("repo").GetString().Should().Be("repo");
            vars0.GetProperty("number").GetInt32().Should().Be(42);
        }

        // Request 2 runs the mutation, carrying the resolved node ID + commit OID + body.
        using var doc = JsonDocument.Parse(handler.RequestBodies[1]!);
        var root = doc.RootElement;
        root.GetProperty("query").GetString().Should().Contain("addPullRequestReview");
        var vars = root.GetProperty("variables");
        vars.GetProperty("prId").GetString().Should().Be("PR_node_xyz");
        vars.GetProperty("commitOid").GetString().Should().Be("abc1234");
        vars.GetProperty("body").GetString().Should().Be("Summary body");
    }

    [Fact]
    public async Task BeginPendingReviewAsync_SendsEmptyStringBodyExplicitly_NotOmittedField()
    {
        var handler = new RecordingHttpMessageHandler(new[]
        {
            (HttpStatusCode.OK, NodeIdResponse),
            (HttpStatusCode.OK, """{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_x"}}}}"""),
        });
        var svc = NewService(handler);

        await svc.BeginPendingReviewAsync(Ref, "abc1234", "", CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.RequestBodies[1]!);
        var vars = doc.RootElement.GetProperty("variables");
        vars.TryGetProperty("body", out var body).Should().BeTrue();
        body.ValueKind.Should().Be(JsonValueKind.String);
        body.GetString().Should().Be("");
    }

    [Fact]
    public async Task BeginPendingReviewAsync_OnGraphqlError_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(new[]
        {
            (HttpStatusCode.OK, NodeIdResponse),
            (HttpStatusCode.OK, """{"data":null,"errors":[{"message":"Could not resolve to a node with the global id of 'PR_node_xyz'."}]}"""),
        });
        var svc = NewService(handler);

        Func<Task> act = () => svc.BeginPendingReviewAsync(Ref, "abc1234", "Summary", CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task BeginPendingReviewAsync_WhenPullRequestNodeIdNotFound_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"repository":{"pullRequest":null}}}""");
        var svc = NewService(handler);

        Func<Task> act = () => svc.BeginPendingReviewAsync(Ref, "abc1234", "Summary", CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task BeginPendingReviewAsync_NullSummaryBody_ThrowsArgumentNullException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, NodeIdResponse);
        var svc = NewService(handler);

        Func<Task> act = () => svc.BeginPendingReviewAsync(Ref, "abc1234", null!, CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentNullException>();
    }
}
