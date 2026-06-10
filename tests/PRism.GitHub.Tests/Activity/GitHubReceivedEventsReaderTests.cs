using System.Net;
using System.Text;
using FluentAssertions;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubReceivedEventsReaderTests
{
    private static GitHubReceivedEventsReader Sut(FakeHttpMessageHandler handler, string? login = "octocat") =>
        new(new FakeHttpClientFactory(handler, new System.Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"),
            () => System.Threading.Tasks.Task.FromResult(login));

    private static HttpResponseMessage Ok(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private const string ReviewEvent = """
    [{
      "id": "100", "type": "PullRequestReviewEvent",
      "actor": { "login": "alice", "avatar_url": "https://a/alice.png" },
      "repo": { "name": "acme/api" },
      "payload": { "action": "created",
        "pull_request": { "number": 7, "title": "Fix login", "html_url": "https://github.com/acme/api/pull/7", "merged": false } },
      "created_at": "2026-06-09T11:00:00Z"
    }]
    """;

    // REAL GitHub shape: issue.html_url is the /issues/ form; the /pull/ web URL lives
    // ONLY in issue.pull_request.html_url. (A fabricated /pull/ in issue.html_url would
    // certify the URL bug as correct — don't.)
    private const string IssueCommentOnPr = """
    [{
      "id": "101", "type": "IssueCommentEvent",
      "actor": { "login": "bob", "avatar_url": "https://a/bob.png" },
      "repo": { "name": "acme/api" },
      "payload": { "action": "created",
        "issue": { "number": 9, "title": "Bug", "html_url": "https://github.com/acme/api/issues/9",
          "pull_request": { "url": "https://api.github.com/repos/acme/api/pulls/9", "html_url": "https://github.com/acme/api/pull/9" } } },
      "created_at": "2026-06-09T10:00:00Z"
    }]
    """;

    [Fact]
    public async Task Parses_review_event_with_actor_and_pr_number()
    {
        var result = await Sut(FakeHttpMessageHandler.Returns(HttpStatusCode.OK, ReviewEvent)).ReadAsync(default);

        result.Degraded.Should().BeFalse();
        var e = result.Events.Should().ContainSingle().Subject;
        e.Id.Should().Be("100");
        e.Type.Should().Be("PullRequestReviewEvent");
        e.ActorLogin.Should().Be("alice");
        e.PrNumber.Should().Be(7);
        e.HtmlUrl.Should().Be("https://github.com/acme/api/pull/7");
        e.IsPullRequestComment.Should().BeFalse();
    }

    [Fact]
    public async Task IssueComment_marks_pr_comment_and_uses_issue_number()
    {
        var result = await Sut(FakeHttpMessageHandler.Returns(HttpStatusCode.OK, IssueCommentOnPr)).ReadAsync(default);

        var e = result.Events.Should().ContainSingle().Subject;
        e.IsPullRequestComment.Should().BeTrue();
        e.PrNumber.Should().Be(9);
        // Must use the /pull/ web URL (from issue.pull_request.html_url), NOT /issues/,
        // so the in-app link parser builds a /pr/ route.
        e.HtmlUrl.Should().Be("https://github.com/acme/api/pull/9");
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Non_success_degrades_to_empty_without_throwing(HttpStatusCode code)
    {
        var result = await Sut(FakeHttpMessageHandler.Returns(code, "{}")).ReadAsync(default);

        result.Events.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async Task Transport_failure_degrades_without_throwing()
    {
        var result = await Sut(FakeHttpMessageHandler.Throws(new HttpRequestException("boom"))).ReadAsync(default);

        result.Events.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async Task Null_login_degrades_without_calling_github()
    {
        var called = false;
        var handler = new FakeHttpMessageHandler(_ => { called = true; return Ok("[]"); });

        var result = await Sut(handler, login: null).ReadAsync(default);

        called.Should().BeFalse();
        result.Degraded.Should().BeTrue();
    }
}
