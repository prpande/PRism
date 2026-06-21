using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitAttachReplyTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewSubmitter NewService(HttpMessageHandler handler)
        => GitHubReviewServiceFactory.CreateSubmitter(handler);

    [Fact]
    public async Task AttachReplyAsync_PostsMutation_CarryingPendingReviewIdParentThreadIdAndBody()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_reply_456"}}}}""");
        var svc = NewService(handler);

        var result = await svc.AttachReplyAsync(
            Ref, "PRR_pending", "PRRT_parent_thread", "reply body\n\n<!-- prism:client-id:r1 -->", CancellationToken.None);

        result.CommentId.Should().Be("PRRC_reply_456");

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        root.GetProperty("query").GetString().Should().Contain("addPullRequestReviewThreadReply");

        var vars = root.GetProperty("variables");
        vars.GetProperty("prReviewId").GetString().Should().Be("PRR_pending");
        vars.GetProperty("threadId").GetString().Should().Be("PRRT_parent_thread");
        vars.GetProperty("body").GetString().Should().Be("reply body\n\n<!-- prism:client-id:r1 -->");
    }

    [Fact]
    public async Task AttachReplyAsync_OnNotFound_ThrowsReviewThreadNotFound()  // real GitHub shape: top-level type:NOT_FOUND
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a node with the global id of 'PRRT_parent_thread'."}]}""");
        var svc = NewService(handler);

        Func<Task> act = () => svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_y", "body", CancellationToken.None);
        await act.Should().ThrowAsync<ReviewThreadNotFoundException>();
    }

    [Fact]
    public async Task AttachReplyAsync_OnNonNotFoundGraphqlError_ThrowsGitHubGraphQLException()  // guard: translation is code-scoped, not a blanket rewrap
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration."}]}""");
        var svc = NewService(handler);

        Func<Task> act = () => svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_y", "body", CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task AttachReplyAsync_EmptyParentThreadId_ThrowsArgumentException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);

        Func<Task> act = () => svc.AttachReplyAsync(Ref, "PRR_x", "", "body", CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task AttachReplyAsync_NullReplyBody_ThrowsArgumentNullException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);

        Func<Task> act = () => svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_y", null!, CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentNullException>();
    }
}
