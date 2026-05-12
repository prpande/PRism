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
    public async Task DeletePendingReviewThreadAsync_LooksUpThreadComments_ThenDeletesEachByCommentId()
    {
        // GitHub has no delete-thread mutation — the adapter resolves the thread's comments via node(id:)
        // and deletes each via deletePullRequestReviewComment. A duplicate thread has one (body) comment.
        var handler = new RecordingHttpMessageHandler(new[]
        {
            (HttpStatusCode.OK, """{"data":{"node":{"comments":{"nodes":[{"id":"PRRC_body"}]}}}}"""),
            (HttpStatusCode.OK, """{"data":{"deletePullRequestReviewComment":{"pullRequestReview":{"id":"PRR_x"}}}}"""),
        });
        var svc = NewService(handler);

        await svc.DeletePendingReviewThreadAsync(Ref, "PRRT_dupe", CancellationToken.None);

        handler.RequestCount.Should().Be(2);

        using (var lookup = JsonDocument.Parse(handler.RequestBodies[0]!))
        {
            lookup.RootElement.GetProperty("query").GetString().Should().Contain("PullRequestReviewThread");
            lookup.RootElement.GetProperty("variables").GetProperty("threadId").GetString().Should().Be("PRRT_dupe");
        }

        using var del = JsonDocument.Parse(handler.RequestBodies[1]!);
        del.RootElement.GetProperty("query").GetString().Should().Contain("deletePullRequestReviewComment");
        del.RootElement.GetProperty("variables").GetProperty("id").GetString().Should().Be("PRRC_body");
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_ThreadWithReplies_DeletesEveryComment()
    {
        var handler = new RecordingHttpMessageHandler(new[]
        {
            (HttpStatusCode.OK, """{"data":{"node":{"comments":{"nodes":[{"id":"PRRC_body"},{"id":"PRRC_reply1"},{"id":"PRRC_reply2"}]}}}}"""),
            (HttpStatusCode.OK, """{"data":{"deletePullRequestReviewComment":{"pullRequestReview":{"id":"PRR_x"}}}}"""),
            (HttpStatusCode.OK, """{"data":{"deletePullRequestReviewComment":{"pullRequestReview":{"id":"PRR_x"}}}}"""),
            (HttpStatusCode.OK, """{"data":{"deletePullRequestReviewComment":{"pullRequestReview":{"id":"PRR_x"}}}}"""),
        });
        var svc = NewService(handler);

        await svc.DeletePendingReviewThreadAsync(Ref, "PRRT_t", CancellationToken.None);

        handler.RequestCount.Should().Be(4);  // 1 lookup + 3 deletes
        handler.RequestPaths.Should().AllSatisfy(p => p!.Should().EndWith("/graphql"));
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_ThreadAlreadyGone_NodeNull_NoDeletesNoThrow()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """{"data":{"node":null}}""");
        var svc = NewService(handler);

        await svc.DeletePendingReviewThreadAsync(Ref, "PRRT_already_gone", CancellationToken.None);

        handler.RequestCount.Should().Be(1);  // just the lookup; nothing to delete
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_MidLoopDeleteFails_SwallowsAndContinues()
    {
        // Best-effort throughout: if one per-comment delete errors, the rest are still attempted.
        var handler = new RecordingHttpMessageHandler(new[]
        {
            (HttpStatusCode.OK, """{"data":{"node":{"comments":{"nodes":[{"id":"PRRC_body"},{"id":"PRRC_reply"}]}}}}"""),
            (HttpStatusCode.OK, """{"data":null,"errors":[{"message":"Could not resolve to a node with the global id of 'PRRC_body'."}]}"""),  // first delete fails
            (HttpStatusCode.OK, """{"data":{"deletePullRequestReviewComment":{"pullRequestReview":{"id":"PRR_x"}}}}"""),  // second delete succeeds
        });
        var svc = NewService(handler);

        await svc.DeletePendingReviewThreadAsync(Ref, "PRRT_t", CancellationToken.None);  // does NOT throw

        handler.RequestCount.Should().Be(3);  // lookup + both delete attempts
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_OnGraphqlError_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"message":"Something went wrong"}]}""");
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
