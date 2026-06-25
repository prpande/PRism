using System.Text.Json;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

// #593 — reviewer name-list parsers feeding the merge-readiness popover's people section.
public class ParseReviewersTests
{
    private static JsonElement Pr(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void ParseLatestReviewers_splits_approved_and_changes_with_avatars()
    {
        var pr = Pr("""
        {"latestReviews":{"nodes":[
          {"author":{"login":"alice","avatarUrl":"https://a/alice.png"},"state":"APPROVED"},
          {"author":{"login":"bob"},"state":"APPROVED"},
          {"author":{"login":"carol","avatarUrl":"https://a/carol.png"},"state":"CHANGES_REQUESTED"},
          {"author":{"login":"dave"},"state":"COMMENTED"}
        ]}}
        """);

        var (approvers, changes) = GitHubPrParser.ParseLatestReviewers(pr);

        approvers.Should().NotBeNull();
        approvers!.Select(r => r.Login).Should().Equal("alice", "bob");
        approvers![0].AvatarUrl.Should().Be("https://a/alice.png");
        approvers![1].AvatarUrl.Should().BeNull();
        changes.Should().NotBeNull();
        changes!.Select(r => r.Login).Should().Equal("carol"); // COMMENTED excluded
    }

    [Fact]
    public void ParseLatestReviewers_returns_nulls_when_connection_absent()
    {
        var (approvers, changes) = GitHubPrParser.ParseLatestReviewers(Pr("{}"));
        approvers.Should().BeNull();
        changes.Should().BeNull();
    }

    [Fact]
    public void ParseRequestedReviewers_reads_users_and_teams()
    {
        var pr = Pr("""
        {"reviewRequests":{"nodes":[
          {"requestedReviewer":{"login":"erin","avatarUrl":"https://a/erin.png"}},
          {"requestedReviewer":{"name":"platform-team"}},
          {"requestedReviewer":null}
        ]}}
        """);

        var waiting = GitHubPrParser.ParseRequestedReviewers(pr);

        waiting.Should().NotBeNull();
        waiting!.Select(r => r.Login).Should().Equal("erin", "platform-team"); // team falls back to name
        waiting![0].AvatarUrl.Should().Be("https://a/erin.png");
        waiting![1].AvatarUrl.Should().BeNull();
    }

    [Fact]
    public void ParseRequestedReviewers_returns_null_when_absent_or_empty()
    {
        GitHubPrParser.ParseRequestedReviewers(Pr("{}")).Should().BeNull();
        GitHubPrParser.ParseRequestedReviewers(Pr("""{"reviewRequests":{"nodes":[]}}""")).Should().BeNull();
    }
}
