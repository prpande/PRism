using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitFindOwnTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_NoPendingReview_ReturnsNull()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}""");
        var svc = NewService(handler);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        snapshot.Should().BeNull();
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_PendingReviewByAnotherUserOnly_ReturnsNull()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """
            {
              "data": {
                "repository": {
                  "pullRequest": {
                    "reviews": { "nodes": [
                      { "id": "PRR_someoneelse", "viewerDidAuthor": false, "commit": { "oid": "abc1234" }, "createdAt": "2026-05-11T09:00:00Z" }
                    ] },
                    "reviewThreads": { "nodes": [] }
                  }
                }
              }
            }
            """);
        var svc = NewService(handler);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        snapshot.Should().BeNull();
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_PendingReviewExists_ProjectsToSnapshotWithThreadAndReply()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """
            {
              "data": {
                "repository": {
                  "pullRequest": {
                    "reviews": { "nodes": [
                      { "id": "PRR_mine_123", "viewerDidAuthor": true, "commit": { "oid": "abc1234" }, "createdAt": "2026-05-11T10:00:00Z" }
                    ] },
                    "reviewThreads": { "pageInfo": { "hasNextPage": false }, "nodes": [
                      {
                        "id": "PRRT_t1",
                        "path": "src/Foo.cs",
                        "line": 42,
                        "diffSide": "RIGHT",
                        "originalLine": 42,
                        "isResolved": false,
                        "comments": { "nodes": [
                          { "id": "PRRC_root", "body": "original body\n\n<!-- prism:client-id:d1 -->", "createdAt": "2026-05-11T10:00:05Z", "originalCommit": { "oid": "abc1234" }, "pullRequestReview": { "id": "PRR_mine_123" } },
                          { "id": "PRRC_reply", "body": "reply body\n\n<!-- prism:client-id:r1 -->", "createdAt": "2026-05-11T10:00:06Z", "originalCommit": { "oid": "abc1234" }, "pullRequestReview": { "id": "PRR_mine_123" } }
                        ] }
                      },
                      {
                        "id": "PRRT_foreign",
                        "path": "src/Bar.cs",
                        "line": 7,
                        "diffSide": "RIGHT",
                        "originalLine": 7,
                        "isResolved": true,
                        "comments": { "nodes": [
                          { "id": "PRRC_other", "body": "from a submitted review", "originalCommit": { "oid": "abc1234" }, "pullRequestReview": { "id": "PRR_submitted_999" } }
                        ] }
                      }
                    ] }
                  }
                }
              }
            }
            """);
        var svc = NewService(handler);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);

        snapshot.Should().NotBeNull();
        snapshot!.PullRequestReviewId.Should().Be("PRR_mine_123");
        snapshot.CommitOid.Should().Be("abc1234");
        snapshot.CreatedAt.Should().Be(new DateTimeOffset(2026, 5, 11, 10, 0, 0, TimeSpan.Zero));

        // Only the thread whose root comment belongs to PRR_mine_123 is included; PRRT_foreign is dropped.
        snapshot.Threads.Should().HaveCount(1);
        var t = snapshot.Threads[0];
        t.PullRequestReviewThreadId.Should().Be("PRRT_t1");
        t.FilePath.Should().Be("src/Foo.cs");
        t.LineNumber.Should().Be(42);
        t.Side.Should().Be("RIGHT");
        t.OriginalCommitOid.Should().Be("abc1234");
        t.OriginalLineContent.Should().BeEmpty();   // adapter leaves this for PR5's Resume enrichment
        t.IsResolved.Should().BeFalse();
        t.BodyMarkdown.Should().Be("original body\n\n<!-- prism:client-id:d1 -->");
        t.CreatedAt.Should().Be(new DateTimeOffset(2026, 5, 11, 10, 0, 5, TimeSpan.Zero));  // the root comment's createdAt

        // Comments carries the replies only — the root comment is BodyMarkdown, not Comments[0].
        t.Comments.Should().HaveCount(1);
        t.Comments[0].CommentId.Should().Be("PRRC_reply");
        t.Comments[0].BodyMarkdown.Should().Be("reply body\n\n<!-- prism:client-id:r1 -->");
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_IncludesThreadOurPendingReviewOnlyRepliedTo()
    {
        // A reply to an EXISTING comment (the demo's "reply to a thread" flow) attaches our reply to
        // a thread whose ROOT comment belongs to a prior/other review. SubmitPipeline's Step 4 must
        // see that thread in the snapshot to verify the reply landed — so the projection includes any
        // thread on which our pending review owns at least one comment, not just threads it created.
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """
            {
              "data": {
                "repository": {
                  "pullRequest": {
                    "reviews": { "nodes": [
                      { "id": "PRR_mine", "viewerDidAuthor": true, "commit": { "oid": "abc1234" }, "createdAt": "2026-05-11T10:00:00Z" }
                    ] },
                    "reviewThreads": { "pageInfo": { "hasNextPage": false }, "nodes": [
                      {
                        "id": "PRRT_replied",
                        "path": "src/Foo.cs",
                        "line": 9,
                        "diffSide": "RIGHT",
                        "originalLine": 9,
                        "isResolved": false,
                        "comments": { "nodes": [
                          { "id": "PRRC_theirs", "body": "an existing comment from someone's submitted review", "createdAt": "2026-05-01T08:00:00Z", "originalCommit": { "oid": "old999" }, "pullRequestReview": { "id": "PRR_someone_else_submitted" } },
                          { "id": "PRRC_ourreply", "body": "our pending reply\n\n<!-- prism:client-id:r1 -->", "createdAt": "2026-05-11T10:05:00Z", "originalCommit": { "oid": "abc1234" }, "pullRequestReview": { "id": "PRR_mine" } }
                        ] }
                      },
                      {
                        "id": "PRRT_unrelated",
                        "path": "src/Bar.cs",
                        "line": 1,
                        "diffSide": "RIGHT",
                        "originalLine": 1,
                        "isResolved": false,
                        "comments": { "nodes": [
                          { "id": "PRRC_x", "body": "totally unrelated thread", "createdAt": "2026-05-02T08:00:00Z", "originalCommit": { "oid": "old999" }, "pullRequestReview": { "id": "PRR_another_submitted" } }
                        ] }
                      }
                    ] }
                  }
                }
              }
            }
            """);
        var svc = NewService(handler);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);

        snapshot.Should().NotBeNull();
        // PRRT_replied is in (we own PRRC_ourreply); PRRT_unrelated is out (we own nothing on it).
        snapshot!.Threads.Should().HaveCount(1);
        var t = snapshot.Threads[0];
        t.PullRequestReviewThreadId.Should().Be("PRRT_replied");
        t.BodyMarkdown.Should().Be("an existing comment from someone's submitted review");  // root comment's body, not ours
        t.CreatedAt.Should().Be(new DateTimeOffset(2026, 5, 1, 8, 0, 0, TimeSpan.Zero));     // root comment's createdAt
        t.Comments.Should().HaveCount(1);
        t.Comments[0].CommentId.Should().Be("PRRC_ourreply");
        t.Comments[0].BodyMarkdown.Should().Be("our pending reply\n\n<!-- prism:client-id:r1 -->");
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_QueryFiltersToPendingState_AndFetchesReviewThreads()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}""");
        var svc = NewService(handler);

        await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);

        handler.RequestCount.Should().Be(1);
        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        var query = root.GetProperty("query").GetString()!;
        query.Should().Contain("states: [PENDING]");
        query.Should().Contain("viewerDidAuthor");
        query.Should().Contain("reviewThreads");
        query.Should().Contain("hasNextPage");   // truncation guard
        var vars = root.GetProperty("variables");
        vars.GetProperty("owner").GetString().Should().Be("owner");
        vars.GetProperty("repo").GetString().Should().Be("repo");
        vars.GetProperty("number").GetInt32().Should().Be(42);
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_PrNotFound_ReturnsNull()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":{"repository":{"pullRequest":null}}}""");
        var svc = NewService(handler);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        snapshot.Should().BeNull();
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_ReviewThreadsTruncated_ThrowsGitHubGraphQLException()
    {
        // Pagination truncation is silent (no GraphQL `errors`), so the method fails loud on hasNextPage
        // rather than return a partial snapshot the submit pipeline would act on.
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """
            {
              "data": {
                "repository": {
                  "pullRequest": {
                    "reviews": { "nodes": [
                      { "id": "PRR_mine", "viewerDidAuthor": true, "commit": { "oid": "abc1234" }, "createdAt": "2026-05-11T10:00:00Z" }
                    ] },
                    "reviewThreads": { "pageInfo": { "hasNextPage": true }, "nodes": [] }
                  }
                }
              }
            }
            """);
        var svc = NewService(handler);

        Func<Task> act = () => svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>().WithMessage("*more than 100 review threads*");
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_ThreadWithNeitherLineNorOriginalLine_ThrowsGitHubGraphQLException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """
            {
              "data": {
                "repository": {
                  "pullRequest": {
                    "reviews": { "nodes": [
                      { "id": "PRR_mine", "viewerDidAuthor": true, "commit": { "oid": "abc1234" }, "createdAt": "2026-05-11T10:00:00Z" }
                    ] },
                    "reviewThreads": { "pageInfo": { "hasNextPage": false }, "nodes": [
                      {
                        "id": "PRRT_bad",
                        "path": "src/Foo.cs",
                        "diffSide": "RIGHT",
                        "isResolved": false,
                        "comments": { "nodes": [
                          { "id": "PRRC_root", "body": "x", "originalCommit": { "oid": "abc1234" }, "pullRequestReview": { "id": "PRR_mine" } }
                        ] }
                      }
                    ] }
                  }
                }
              }
            }
            """);
        var svc = NewService(handler);

        Func<Task> act = () => svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        await act.Should().ThrowAsync<GitHubGraphQLException>().WithMessage("*neither line nor originalLine*");
    }
}
