using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServicePrDetailTests
{
    private static GitHubReviewService NewService(HttpMessageHandler handler)
        => GitHubReviewServiceFactory.Create(handler);

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
            "author": { "login": "alice", "avatarUrl": "https://avatars.githubusercontent.com/u/1?v=4" },
            "createdAt": "2026-01-01T00:00:00Z",
            "closedAt": null,
            "mergedAt": null,
            "changedFiles": 7,
            "comments": {
              "pageInfo": { "hasNextPage": false, "endCursor": null },
              "nodes": [
                { "databaseId": 1001, "author": { "login": "bob", "avatarUrl": "https://avatars.githubusercontent.com/u/2?v=4" }, "createdAt": "2026-01-02T00:00:00Z", "body": "looks good" }
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
                      { "id": "PRC_c1", "author": { "login": "bob", "avatarUrl": "https://avatars.githubusercontent.com/u/2?v=4" }, "createdAt": "2026-01-02T00:01:00Z", "body": "nit", "lastEditedAt": null }
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

    // Same shape as PrDetailGraphQLBody but with NO "url" field — exercises the
    // empty→null normalization in ParsePr.
    private const string PrDetailNoUrlBody = """
    {
      "data": {
        "repository": {
          "pullRequest": {
            "title": "No url here",
            "body": "",
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
            "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
          }
        }
      }
    }
    """;

    [Fact]
    public async Task GetPrDetailAsync_maps_url_to_HtmlUrl()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailGraphQLBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 42), CancellationToken.None);

        dto!.Pr.HtmlUrl.Should().Be("https://github.com/o/r/pull/42");
    }

    // Explicit empty-string url ("url": "") — the OTHER branch of the empty→null
    // normalization (vs the absent-field PrDetailNoUrlBody). GetStr returns "" for
    // both an absent field and a present-but-empty value; both must map to null.
    private static readonly string PrDetailEmptyUrlBody =
        PrDetailNoUrlBody.Replace(
            "\"title\": \"No url here\",",
            "\"title\": \"No url here\",\n            \"url\": \"\",",
            StringComparison.Ordinal);

    [Fact]
    public async Task GetPrDetailAsync_maps_absent_url_to_null_HtmlUrl()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailNoUrlBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto!.Pr.HtmlUrl.Should().BeNull();
    }

    [Fact]
    public async Task GetPrDetailAsync_maps_empty_url_to_null_HtmlUrl()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailEmptyUrlBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto!.Pr.HtmlUrl.Should().BeNull();
    }

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

    [Fact]
    public async Task GetPrDetailAsync_throws_GitHubGraphQLException_on_errors_without_data()
    {
        // GraphQL responses are HTTP 200 even on execution errors; the errors[] array
        // carries them. When data is absent (or null) and errors[] is non-empty, that's
        // a fatal execution failure — surface as an exception so the caller doesn't
        // mistake it for "PR not found."
        var body = "{\"errors\":[{\"message\":\"rate limit exceeded\",\"type\":\"RATE_LIMITED\"}]}";
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        await NewService(handler).Invoking(s =>
                s.GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None))
            .Should().ThrowAsync<GitHubGraphQLException>();
    }

    [Fact]
    public async Task GetPrDetailAsync_returns_null_when_data_repository_is_null_with_errors()
    {
        // Permission-denied shape: data.repository:null + errors[]. The pullRequest
        // path is unreachable but data is technically present, so this is "PR not
        // found / not accessible" semantics — return null (do NOT throw).
        var body = "{\"data\":{\"repository\":null},\"errors\":[{\"message\":\"Could not resolve to a Repository\"}]}";
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 999), CancellationToken.None);

        dto.Should().BeNull();
    }

    [Theory]
    [InlineData("OPEN",   null,                   false, false)]
    [InlineData("CLOSED", null,                   true,  false)]
    [InlineData("MERGED", "2026-02-01T00:00:00Z", false, true)]
    public async Task GetPrDetailAsync_isClosed_excludes_merged_prs(string state, string? mergedAt, bool expectedClosed, bool expectedMerged)
    {
        // IsClosed means "closed WITHOUT merging." MERGED PRs report IsMerged=true and
        // IsClosed=false; CLOSED-without-merge PRs report IsClosed=true. Consumers asking
        // "is this PR no longer open?" must check `IsMerged || IsClosed`.
        var mergedAtJson = mergedAt is null ? "null" : $"\"{mergedAt}\"";
        var body = $$"""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "title": "x", "body": "", "url": "https://github.com/o/r/pull/1",
                "state": "{{state}}", "isDraft": false,
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "headRefName": "h", "baseRefName": "main",
                "headRefOid": "h", "baseRefOid": "b",
                "author": { "login": "a" },
                "createdAt": "2026-01-01T00:00:00Z",
                "closedAt": null,
                "mergedAt": {{mergedAtJson}},
                "changedFiles": 0,
                "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
              }
            }
          }
        }
        """;
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.IsClosed.Should().Be(expectedClosed);
        dto.Pr.IsMerged.Should().Be(expectedMerged);
    }

    [Fact]
    public async Task GetPrDetailAsync_default_clustering_quality_is_low_until_loader_overwrites()
    {
        // ClusteringQuality.Ok would imply "trustworthy iteration boundaries exist."
        // Iterations is null here (PrDetailLoader fills both fields later). Defaulting
        // to Low keeps the DTO internally consistent — Ok+null Iterations would
        // contradict the contract. Spec § 6.4 + Q5 redesign.
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailGraphQLBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 42), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.ClusteringQuality.Should().Be(ClusteringQuality.Low);
        dto.Iterations.Should().BeNull();
    }

    [Fact]
    public async Task GetPrDetailAsync_surfaces_mergedAt_on_merged_pr()
    {
        // Spec § 5.2.1: ParsePr must propagate mergedAt from the GraphQL payload into
        // Pr.MergedAt so consumers can display the merge timestamp.
        var body = """
        {
          "data": {
            "repository": {
              "pullRequest": {
                "title": "x", "body": "", "url": "https://github.com/o/r/pull/7",
                "state": "MERGED", "isDraft": false,
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "headRefName": "h", "baseRefName": "main",
                "headRefOid": "h", "baseRefOid": "b",
                "author": { "login": "a" },
                "createdAt": "2026-01-01T00:00:00Z",
                "closedAt": "2026-03-01T12:00:00Z",
                "mergedAt": "2026-03-01T12:00:00Z",
                "changedFiles": 0,
                "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
              }
            }
          }
        }
        """;
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 7), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.MergedAt.Should().Be(DateTimeOffset.Parse("2026-03-01T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        dto.Pr.ClosedAt.Should().Be(DateTimeOffset.Parse("2026-03-01T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task GetPrDetailAsync_surfaces_closedAt_and_null_mergedAt_on_closed_unmerged_pr()
    {
        // Spec § 5.2.1: For a PR closed without merging, ClosedAt must be non-null
        // and MergedAt must be null.
        var body = """
        {
          "data": {
            "repository": {
              "pullRequest": {
                "title": "x", "body": "", "url": "https://github.com/o/r/pull/8",
                "state": "CLOSED", "isDraft": false,
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "headRefName": "h", "baseRefName": "main",
                "headRefOid": "h", "baseRefOid": "b",
                "author": { "login": "a" },
                "createdAt": "2026-01-01T00:00:00Z",
                "closedAt": "2026-04-15T09:30:00Z",
                "mergedAt": null,
                "changedFiles": 0,
                "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
                "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
              }
            }
          }
        }
        """;
        var handler = new GraphQLPlusRestHandler { GraphQLBody = body };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 8), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.MergedAt.Should().BeNull();
        dto.Pr.ClosedAt.Should().Be(DateTimeOffset.Parse("2026-04-15T09:30:00Z", System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task GetPrDetailAsync_carries_avatar_urls_for_author_and_comments()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailGraphQLBody };
        var svc = NewService(handler);

        var dto = await svc.GetPrDetailAsync(new PrReference("o", "r", 42), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.AvatarUrl.Should().Be("https://avatars.githubusercontent.com/u/1?v=4");
        dto.RootComments.Single().AvatarUrl.Should().Be("https://avatars.githubusercontent.com/u/2?v=4");
        dto.ReviewComments.Single().Comments.Single().AvatarUrl
            .Should().Be("https://avatars.githubusercontent.com/u/2?v=4");
    }

    [Fact]
    public async Task GetPrDetailAsync_carries_bot_avatar_and_tolerates_missing_avatar()
    {
        // Bot author keeps its avatarUrl (the case client-side github.com/{login}.png would 404);
        // a missing avatarUrl maps to null, not an exception.
        const string body = """
        {
          "data": { "repository": { "pullRequest": {
            "title": "t", "body": "", "url": "u", "state": "OPEN", "isDraft": false,
            "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "headRefName": "h", "baseRefName": "main", "headRefOid": "h", "baseRefOid": "b",
            "author": { "login": "dependabot[bot]", "avatarUrl": "https://avatars.githubusercontent.com/in/29110?v=4" },
            "createdAt": "2026-01-01T00:00:00Z", "closedAt": null, "mergedAt": null, "changedFiles": 0,
            "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [
              { "databaseId": 1, "author": { "login": "ghost" }, "createdAt": "2026-01-02T00:00:00Z", "body": "x" }
            ] },
            "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
            "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
          } } }
        }
        """;
        var svc = NewService(new GraphQLPlusRestHandler { GraphQLBody = body });

        var dto = await svc.GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto.Should().NotBeNull();
        dto!.Pr.AvatarUrl.Should().Be("https://avatars.githubusercontent.com/in/29110?v=4");
        dto.RootComments.Single().AvatarUrl.Should().BeNull();
    }
}
