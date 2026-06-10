using System;
using System.Collections.Generic;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Activity;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubPrTimelineReaderTests
{
    private static GitHubPrTimelineReader MakeReader(HttpStatusCode code, string json)
        => new(
            new FakeHttpClientFactory(FakeHttpMessageHandler.Returns(code, json), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");

    private static readonly IReadOnlyCollection<(string Repo, int PrNumber)> OnePr =
        new[] { ("acme/api", 7) };

    [Fact]
    public async Task Parses_approved_review()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{"timelineItems":{"nodes":[
          {"__typename":"PullRequestReview","state":"APPROVED",
           "author":{"login":"alice","avatarUrl":"https://a/alice","__typename":"User"}}]}}}}}
        """;
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(OnePr, CancellationToken.None);
        var a = r[("acme/api", 7)];
        a.Login.Should().Be("alice");
        a.AvatarUrl.Should().Be("https://a/alice");
        a.IsBot.Should().BeFalse();
        a.Verb.Should().Be(ActivityVerb.Approved);
    }

    [Fact]
    public async Task Parses_changes_requested_review()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{"timelineItems":{"nodes":[
          {"__typename":"PullRequestReview","state":"CHANGES_REQUESTED",
           "author":{"login":"bob","__typename":"User"}}]}}}}}
        """;
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(OnePr, CancellationToken.None);
        r[("acme/api", 7)].Verb.Should().Be(ActivityVerb.ChangesRequested);
    }

    [Fact]
    public async Task Parses_issue_comment()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{"timelineItems":{"nodes":[
          {"__typename":"IssueComment","author":{"login":"carol","__typename":"User"}}]}}}}}
        """;
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(OnePr, CancellationToken.None);
        r[("acme/api", 7)].Verb.Should().Be(ActivityVerb.Commented);
    }

    [Fact]
    public async Task Parses_commit_as_pushed_from_commit_author_user()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{"timelineItems":{"nodes":[
          {"__typename":"PullRequestCommit","commit":{"author":{"user":{"login":"dan","__typename":"User"}}}}]}}}}}
        """;
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(OnePr, CancellationToken.None);
        var a = r[("acme/api", 7)];
        a.Login.Should().Be("dan");
        a.Verb.Should().Be(ActivityVerb.Pushed);
    }

    [Fact]
    public async Task Flags_bot_actor_by_typename()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{"timelineItems":{"nodes":[
          {"__typename":"IssueComment","author":{"login":"dependabot","__typename":"Bot"}}]}}}}}
        """;
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(OnePr, CancellationToken.None);
        r[("acme/api", 7)].IsBot.Should().BeTrue();
    }

    [Fact]
    public async Task Commit_without_github_user_is_dropped()
    {
        // A commit whose author isn't a GitHub user (no .user) has no attributable actor.
        const string json = """
        {"data":{"a0":{"pullRequest":{"timelineItems":{"nodes":[
          {"__typename":"PullRequestCommit","commit":{"author":{"user":null}}}]}}}}}
        """;
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(OnePr, CancellationToken.None);
        r.Should().BeEmpty();
    }

    [Fact]
    public async Task Resolves_only_the_aliases_present_in_data()
    {
        // a0 resolves, a1 errored to null (partial GraphQL response) → only a0 in the map.
        const string json = """
        {"data":{
          "a0":{"pullRequest":{"timelineItems":{"nodes":[
            {"__typename":"IssueComment","author":{"login":"alice","__typename":"User"}}]}}},
          "a1":null}}
        """;
        var prs = new[] { ("acme/api", 7), ("acme/web", 9) };
        var r = await MakeReader(HttpStatusCode.OK, json).ReadLatestAsync(prs, CancellationToken.None);
        r.Should().ContainSingle();
        r.Should().ContainKey(("acme/api", 7));
    }

    [Fact]
    public async Task Non_success_degrades_to_empty()
        => (await MakeReader(HttpStatusCode.Forbidden, "").ReadLatestAsync(OnePr, CancellationToken.None))
            .Should().BeEmpty();

    [Fact]
    public async Task Malformed_json_degrades_to_empty()
        => (await MakeReader(HttpStatusCode.OK, "NOT JSON {{{").ReadLatestAsync(OnePr, CancellationToken.None))
            .Should().BeEmpty();

    [Fact]
    public async Task Empty_input_returns_empty()
        => (await MakeReader(HttpStatusCode.OK, "{}").ReadLatestAsync(Array.Empty<(string, int)>(), CancellationToken.None))
            .Should().BeEmpty();

    [Fact]
    public async Task Genuine_cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => MakeReader(HttpStatusCode.OK, "{}").ReadLatestAsync(OnePr, cts.Token));
    }
}
