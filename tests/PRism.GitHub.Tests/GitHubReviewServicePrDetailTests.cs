using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServicePrDetailTests
{
    private static IReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    private const string PrDetailGraphQLBody = """
    {
      "data": {
        "repository": {
          "pullRequest": {
            "title": "Add widget pipeline",
            "body": "Implements widget v1",
            "url": "https://github.com/o/r/pull/42",
            "state": "OPEN",
            "isDraft": false,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "BEHIND",
            "headRefName": "feat/widget",
            "baseRefName": "main",
            "headRefOid": "head-sha-42",
            "baseRefOid": "base-sha-42",
            "author": { "login": "alice" },
            "createdAt": "2026-01-01T00:00:00Z",
            "closedAt": null,
            "mergedAt": null,
            "changedFiles": 7,
            "comments": {
              "pageInfo": { "hasNextPage": false, "endCursor": null },
              "nodes": [
                { "databaseId": 1001, "author": { "login": "bob" }, "createdAt": "2026-01-02T00:00:00Z", "body": "looks good" }
              ]
            },
            "reviewThreads": {
              "pageInfo": { "hasNextPage": false, "endCursor": null },
              "nodes": [
                {
                  "id": "PRRT_thread1",
                  "path": "src/Widget.cs",
                  "line": 42,
                  "isResolved": false,
                  "comments": {
                    "nodes": [
                      { "id": "PRC_c1", "author": { "login": "bob" }, "createdAt": "2026-01-02T00:01:00Z", "body": "nit", "lastEditedAt": null }
                    ]
                  }
                }
              ]
            },
            "timelineItems": {
              "pageInfo": { "hasNextPage": false, "endCursor": null },
              "nodes": []
            }
          }
        }
      }
    }
    """;

    private const string PrDetailWithCapHitBody = """
    {
      "data": {
        "repository": {
          "pullRequest": {
            "title": "huge",
            "body": "",
            "url": "https://github.com/o/r/pull/1",
            "state": "OPEN",
            "isDraft": false,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "headRefName": "h",
            "baseRefName": "main",
            "headRefOid": "h",
            "baseRefOid": "b",
            "author": { "login": "alice" },
            "createdAt": "2026-01-01T00:00:00Z",
            "closedAt": null,
            "mergedAt": null,
            "changedFiles": 0,
            "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
            "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
            "timelineItems": { "pageInfo": { "hasNextPage": true, "endCursor": "cursor-xyz" }, "nodes": [] }
          }
        }
      }
    }
    """;

    [Fact]
    public async Task GetPrDetailAsync_parses_pr_meta_root_comments_and_review_threads()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailGraphQLBody };
        var sut = NewService(handler);

        var dto = await sut.GetPrDetailAsync(new PrReference("o", "r", 42), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.Title.Should().Be("Add widget pipeline");
        dto.Pr.Author.Should().Be("alice");
        dto.Pr.HeadSha.Should().Be("head-sha-42");
        dto.Pr.BaseSha.Should().Be("base-sha-42");
        dto.Pr.HeadBranch.Should().Be("feat/widget");
        dto.Pr.BaseBranch.Should().Be("main");
        dto.Pr.Mergeability.Should().Be("MERGEABLE");
        dto.Pr.IsMerged.Should().BeFalse();
        dto.Pr.IsClosed.Should().BeFalse();

        dto.RootComments.Should().HaveCount(1);
        dto.RootComments[0].Author.Should().Be("bob");
        dto.RootComments[0].Body.Should().Be("looks good");

        dto.ReviewComments.Should().HaveCount(1);
        dto.ReviewComments[0].FilePath.Should().Be("src/Widget.cs");
        dto.ReviewComments[0].LineNumber.Should().Be(42);
        dto.ReviewComments[0].Comments.Should().HaveCount(1);

        dto.TimelineCapHit.Should().BeFalse();
    }

    [Fact]
    public async Task GetPrDetailAsync_sets_TimelineCapHit_when_any_connection_has_next_page()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailWithCapHitBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto!.TimelineCapHit.Should().BeTrue();
    }

    [Fact]
    public async Task GetPrDetailAsync_returns_null_when_pull_request_node_is_null()
    {
        // GitHub returns { data: { repository: { pullRequest: null } } } for non-existent PRs.
        var handler = new GraphQLPlusRestHandler
        {
            GraphQLBody = "{\"data\":{\"repository\":{\"pullRequest\":null}}}",
        };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 999), CancellationToken.None);

        dto.Should().BeNull();
    }
}
