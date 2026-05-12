using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitAttachThreadTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    [Fact]
    public async Task AttachThreadAsync_PostsAddPullRequestReviewThreadMutation_WithReviewIdBodyAndLocation()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_thread_123"}}}}""");
        var svc = NewService(handler);

        var draft = new DraftThreadRequest(
            DraftId: "draft-1",
            BodyMarkdown: "issue here\n\n<!-- prism:client-id:draft-1 -->",
            FilePath: "src/Foo.cs",
            LineNumber: 42,
            Side: "RIGHT");

        var result = await svc.AttachThreadAsync(Ref, "PRR_pending_xyz", draft, CancellationToken.None);

        result.PullRequestReviewThreadId.Should().Be("PRRT_thread_123");

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        root.GetProperty("query").GetString().Should().Contain("addPullRequestReviewThread");

        var vars = root.GetProperty("variables");
        // Field name per spec § 4 / C6 outcome (verified 2026-05-12: pullRequestReviewId present, not deprecated).
        vars.GetProperty("prReviewId").GetString().Should().Be("PRR_pending_xyz");
        vars.GetProperty("body").GetString().Should().Be("issue here\n\n<!-- prism:client-id:draft-1 -->");
        vars.GetProperty("path").GetString().Should().Be("src/Foo.cs");
        vars.GetProperty("line").GetInt32().Should().Be(42);
        vars.GetProperty("side").GetString().Should().Be("RIGHT");
        // Multi-line range fields stay out of the payload in PoC scope.
        vars.TryGetProperty("startLine", out _).Should().BeFalse();
        vars.TryGetProperty("startSide", out _).Should().BeFalse();
    }

    [Fact]
    public async Task AttachThreadAsync_OnGraphqlError_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"message":"pull request review thread target line is invalid"}]}""");
        var svc = NewService(handler);

        var draft = new DraftThreadRequest("d", "b", "p", 1, "RIGHT");

        Func<Task> act = () => svc.AttachThreadAsync(Ref, "PRR_x", draft, CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task AttachThreadAsync_NullDraft_ThrowsArgumentNullException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);

        Func<Task> act = () => svc.AttachThreadAsync(Ref, "PRR_x", null!, CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task AttachThreadAsync_EmptyPendingReviewId_ThrowsArgumentException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, "{}");
        var svc = NewService(handler);
        var draft = new DraftThreadRequest("d", "b", "p", 1, "RIGHT");

        Func<Task> act = () => svc.AttachThreadAsync(Ref, "", draft, CancellationToken.None);
        await act.Should().ThrowAsync<ArgumentException>();
    }
}
