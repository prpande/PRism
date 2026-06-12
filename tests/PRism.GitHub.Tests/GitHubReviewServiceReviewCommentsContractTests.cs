using System.Net;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class GitHubReviewServiceReviewCommentsContractTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
        => GitHubReviewServiceFactory.Create(handler);

    private static ReviewCommentRequest SampleReq =>
        new(CommitOid: "deadbeef", FilePath: "src/Foo.cs", LineNumber: 42, Side: "RIGHT",
            BodyMarkdown: "a comment");

    [Fact]
    public async Task CreateReviewCommentAsync_On2xx_MissingId_ThrowsContractException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created, """{"created_at":"2026-06-02T10:30:00Z"}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateReviewCommentAsync(Ref, SampleReq, CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }

    [Fact]
    public async Task CreateReviewCommentAsync_On2xx_MissingCreatedAt_ThrowsContractException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, """{"id":555}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateReviewCommentAsync(Ref, SampleReq, CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }

    [Fact]
    public async Task CreateReviewCommentAsync_OnGenuine422_StillThrowsHttpRequestException()
    {
        // Regression: a real non-2xx must remain an HttpRequestException carrying the status.
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.UnprocessableEntity, """{"message":"Validation failed"}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateReviewCommentAsync(Ref, SampleReq, CancellationToken.None);

        var ex = (await act.Should().ThrowAsync<HttpRequestException>()).Which;
        ex.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }
}
