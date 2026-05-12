using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitDeleteTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    [Fact]
    public async Task DeletePendingReviewAsync_PostsDeletePullRequestReviewMutation()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"deletePullRequestReview":{"pullRequestReview":{"id":"PRR_x"}}}}""");
        var svc = NewService(handler);

        await svc.DeletePendingReviewAsync(Ref, "PRR_x", CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        root.GetProperty("query").GetString().Should().Contain("deletePullRequestReview");
        root.GetProperty("variables").GetProperty("prReviewId").GetString().Should().Be("PRR_x");
    }

    [Fact]
    public async Task DeletePendingReviewAsync_OnGraphqlError_ThrowsGitHubGraphQLException()
    {
        // Callers (stale-commitOID recreate, closed/merged bulk-discard courtesy delete) treat this
        // as best-effort and catch/log; the interface contract is still "throws on GraphQL error".
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"message":"Could not resolve to a node with the global id of 'PRR_x'."}]}""");
        var svc = NewService(handler);

        Func<Task> act = () => svc.DeletePendingReviewAsync(Ref, "PRR_missing", CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task DeletePendingReviewAsync_EmptyId_ThrowsArgumentException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);

        Func<Task> act = () => svc.DeletePendingReviewAsync(Ref, "", CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_PostsDeletePullRequestReviewThreadMutation()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"deletePullRequestReviewThread":{"thread":{"id":"PRRT_dupe"}}}}""");
        var svc = NewService(handler);

        await svc.DeletePendingReviewThreadAsync(Ref, "PRRT_dupe", CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        root.GetProperty("query").GetString().Should().Contain("deletePullRequestReviewThread");
        root.GetProperty("variables").GetProperty("threadId").GetString().Should().Be("PRRT_dupe");
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_OnGraphqlError_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"message":"NOT_FOUND"}]}""");
        var svc = NewService(handler);

        Func<Task> act = () => svc.DeletePendingReviewThreadAsync(Ref, "PRRT_missing", CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_EmptyId_ThrowsArgumentException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);

        Func<Task> act = () => svc.DeletePendingReviewThreadAsync(Ref, "", CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentException>();
    }
}
