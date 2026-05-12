using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitFinalizeTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    [Theory]
    [InlineData(SubmitEvent.Approve, "APPROVE")]
    [InlineData(SubmitEvent.RequestChanges, "REQUEST_CHANGES")]
    [InlineData(SubmitEvent.Comment, "COMMENT")]
    public async Task FinalizePendingReviewAsync_SubmitsWithCorrectEventMapping(SubmitEvent verdict, string expectedGraphqlEvent)
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"submitPullRequestReview":{"pullRequestReview":{"id":"PRR_done","state":"APPROVED"}}}}""");
        var svc = NewService(handler);

        await svc.FinalizePendingReviewAsync(Ref, "PRR_x", verdict, CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        root.GetProperty("query").GetString().Should().Contain("submitPullRequestReview");
        var vars = root.GetProperty("variables");
        vars.GetProperty("prReviewId").GetString().Should().Be("PRR_x");
        vars.GetProperty("event").GetString().Should().Be(expectedGraphqlEvent);
    }

    [Fact]
    public async Task FinalizePendingReviewAsync_OnGraphqlError_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"message":"Can not submit a pending review without comments"}]}""");
        var svc = NewService(handler);

        Func<Task> act = () => svc.FinalizePendingReviewAsync(Ref, "PRR_x", SubmitEvent.Comment, CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task FinalizePendingReviewAsync_EmptyPendingReviewId_ThrowsArgumentException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);

        Func<Task> act = () => svc.FinalizePendingReviewAsync(Ref, "", SubmitEvent.Comment, CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentException>();
    }
}
