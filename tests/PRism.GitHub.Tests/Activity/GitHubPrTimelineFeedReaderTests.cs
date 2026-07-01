using System.Net;
using FluentAssertions;
using PRism.Core.Activity;
using PRism.Core.Contracts;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubPrTimelineFeedReaderTests
{
    private static readonly PrReference Pr = new("acme", "api", 7);

    private static GitHubPrTimelineFeedReader MakeReader(HttpStatusCode code, string json)
        => new(
            new FakeHttpClientFactory(FakeHttpMessageHandler.Returns(code, json), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");

    [Fact]
    public async Task Maps_review_and_commit_nodes_newest_first()
    {
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{
            "pageInfo":{"hasPreviousPage":true,"startCursor":"CUR"},
            "nodes":[
              {"__typename":"PullRequestCommit","commit":{"oid":"deadbeef","committedDate":"2021-01-01T00:00:00Z","author":{"user":{"login":"bob","avatarUrl":"https://a/bob","__typename":"User"}}}},
              {"__typename":"PullRequestReview","state":"APPROVED","body":"","submittedAt":"2021-01-02T00:00:00Z","author":{"login":"alice","avatarUrl":"https://a/alice","__typename":"User"}}
            ]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.HasOlder.Should().BeTrue();
        page.OlderCursor.Should().Be("CUR");
        page.Events.Should().HaveCount(2);
        page.Events[0].Verb.Should().Be(ActivityVerb.Approved);      // newest first
        page.Events[0].Actor.Login.Should().Be("alice");
        page.Events[1].Verb.Should().Be(ActivityVerb.Pushed);
        page.Events[1].CommitCount.Should().Be(1);
    }

    [Fact]
    public async Task Maps_ready_for_review_node_to_other_not_reviewed()
    {
        // Draft→ready is not a review outcome — mapping it to Reviewed would misleadingly render
        // "<author> reviewed". It maps to Other (renders the neutral "updated" phrase) instead.
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{
            "pageInfo":{"hasPreviousPage":true,"startCursor":"CUR"},
            "nodes":[
              {"__typename":"ReadyForReviewEvent","createdAt":"2021-01-01T00:00:00Z","actor":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"}}
            ]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.Events.Should().ContainSingle();
        page.Events[0].Verb.Should().Be(ActivityVerb.Other);
        page.Events[0].Actor.Login.Should().Be("opener");
    }

    [Fact]
    public async Task Synthesizes_opened_node_when_no_older_pages()
    {
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{"pageInfo":{"hasPreviousPage":false,"startCursor":null},"nodes":[]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.HasOlder.Should().BeFalse();
        page.Events.Should().ContainSingle();
        page.Events[^1].Verb.Should().Be(ActivityVerb.Opened);
        page.Events[^1].Actor.Login.Should().Be("opener");
    }

    [Fact]
    public async Task Degrades_to_flagged_empty_page_on_non_success()
    {
        var page = await MakeReader(HttpStatusCode.BadGateway, "{}").ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);
        page.Events.Should().BeEmpty();
        page.HasOlder.Should().BeFalse();
        page.Degraded.Should().BeTrue();   // failure ≠ genuine-empty: the endpoint maps this to 502
    }

    [Fact]
    public async Task Degrades_on_malformed_json()
    {
        var page = await MakeReader(HttpStatusCode.OK, "{ not json").ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);
        page.Events.Should().BeEmpty();
        page.HasOlder.Should().BeFalse();
        page.Degraded.Should().BeTrue();   // truncated/malformed body ≠ genuine-empty
    }

    [Fact]
    public async Task Degrades_on_transport_failure()
    {
        var reader = new GitHubPrTimelineFeedReader(
            new FakeHttpClientFactory(FakeHttpMessageHandler.Throws(new HttpRequestException("boom")), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");

        var page = await reader.ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.Events.Should().BeEmpty();
        page.HasOlder.Should().BeFalse();
        page.Degraded.Should().BeTrue();   // connection refused / DNS failure ≠ genuine-empty
    }

    [Fact]
    public async Task Orders_same_timestamp_nodes_deterministically()
    {
        // Two nodes with the identical committedDate/submittedAt: order must be stable by id, not
        // by GraphQL array happenstance (spec decision #4). Same JSON read twice → identical order.
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z","author":{"login":"opener","avatarUrl":null,"__typename":"User"},
          "timelineItems":{"pageInfo":{"hasPreviousPage":true,"startCursor":"CUR"},"nodes":[
            {"__typename":"PullRequestReview","state":"APPROVED","body":"","submittedAt":"2021-05-05T00:00:00Z","author":{"login":"zoe","avatarUrl":null,"__typename":"User"}},
            {"__typename":"PullRequestReview","state":"APPROVED","body":"","submittedAt":"2021-05-05T00:00:00Z","author":{"login":"amy","avatarUrl":null,"__typename":"User"}}
          ]}}}}}
        """;
        var first = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, null, 30, CancellationToken.None);
        var second = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, null, 30, CancellationToken.None);
        first.Events.Select(e => e.Id).Should().Equal(second.Events.Select(e => e.Id));   // stable across reads
    }

    [Fact]
    public async Task Distinct_requested_reviewers_at_same_actor_and_timestamp_get_distinct_ids()
    {
        // Two ReviewRequestedEvent nodes from the SAME actor at the SAME createdAt (one multi-reviewer
        // request action) must not collide on Id — a colliding Id gets silently deduped away by the
        // frontend's known-Id Set, dropping a requested reviewer from the feed.
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{
            "pageInfo":{"hasPreviousPage":true,"startCursor":"CUR"},
            "nodes":[
              {"__typename":"ReviewRequestedEvent","createdAt":"2021-01-01T00:00:00Z","actor":{"login":"opener","avatarUrl":null,"__typename":"User"},"requestedReviewer":{"login":"amy"}},
              {"__typename":"ReviewRequestedEvent","createdAt":"2021-01-01T00:00:00Z","actor":{"login":"opener","avatarUrl":null,"__typename":"User"},"requestedReviewer":{"login":"bob"}}
            ]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.Events.Should().HaveCount(2);
        page.Events.Select(e => e.Id).Should().OnlyHaveUniqueItems();
        page.Events.Select(e => e.Subject).Should().Contain(new[] { "amy", "bob" });
    }

    [Fact]
    public async Task Review_id_uses_databaseId_when_present()
    {
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{
            "pageInfo":{"hasPreviousPage":true,"startCursor":"CUR"},
            "nodes":[
              {"__typename":"PullRequestReview","databaseId":555,"state":"APPROVED","body":"","submittedAt":"2021-01-02T00:00:00Z","author":{"login":"alice","avatarUrl":"https://a/alice","__typename":"User"}}
            ]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.Events.Should().ContainSingle();
        page.Events[0].Id.Should().Contain("555");
    }

    [Fact]
    public async Task Posts_byte_identical_first_page_query()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK,
            """{"data":{"repository":{"pullRequest":{"createdAt":"2020-01-01T00:00:00Z","author":null,"timelineItems":{"pageInfo":{"hasPreviousPage":false,"startCursor":null},"nodes":[]}}}}}""");
        var reader = new GitHubPrTimelineFeedReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().Be(
            """query{ repository(owner:"acme", name:"api"){ pullRequest(number:7){ createdAt author{ login avatarUrl __typename } timelineItems(last:30, itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,REVIEW_REQUESTED_EVENT,READY_FOR_REVIEW_EVENT,REOPENED_EVENT,CLOSED_EVENT,MERGED_EVENT]){ pageInfo{ hasPreviousPage startCursor } nodes{ __typename ... on IssueComment{ databaseId createdAt body author{ login avatarUrl __typename } } ... on PullRequestReview{ databaseId submittedAt state body author{ login avatarUrl __typename } } ... on PullRequestCommit{ commit{ oid committedDate author{ user{ login avatarUrl __typename } } } } ... on ReviewRequestedEvent{ createdAt actor{ login avatarUrl __typename } requestedReviewer{ ... on User{ login } ... on Team{ name } } } ... on ReadyForReviewEvent{ createdAt actor{ login avatarUrl __typename } } ... on ReopenedEvent{ createdAt actor{ login avatarUrl __typename } } ... on ClosedEvent{ createdAt actor{ login avatarUrl __typename } } ... on MergedEvent{ createdAt actor{ login avatarUrl __typename } } } } } } }""");
    }
}
