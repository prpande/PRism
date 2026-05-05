using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubSectionQueryRunnerTests
{
    private const string SearchResponseOnePr = """
    {
      "items": [
        {
          "number": 42,
          "title": "Test PR",
          "user": { "login": "amelia" },
          "repository_url": "https://api.github.com/repos/acme/api",
          "updated_at": "2026-05-06T10:00:00Z",
          "comments": 3,
          "pull_request": { "html_url": "https://github.com/acme/api/pull/42" }
        }
      ]
    }
    """;

    [Fact]
    public async Task Queries_each_visible_section_with_correct_search_q()
    {
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler((req) =>
        {
            calls.Add(req.RequestUri!.Query);
            return Respond(HttpStatusCode.OK, SearchResponseOnePr);
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubSectionQueryRunner(http, () => Task.FromResult<string?>("t"));

        await sut.QueryAllAsync(new HashSet<string>
        {
            "review-requested", "awaiting-author", "authored-by-me", "mentioned", "ci-failing"
        }, default);

        calls.Should().Contain(q => q.Contains("review-requested%3A%40me", StringComparison.Ordinal));
        calls.Should().Contain(q => q.Contains("reviewed-by%3A%40me", StringComparison.Ordinal));
        calls.Should().Contain(q => q.Contains("author%3A%40me", StringComparison.Ordinal));
        calls.Should().Contain(q => q.Contains("mentions%3A%40me", StringComparison.Ordinal));
        calls.Should().HaveCount(5);
    }

    [Fact]
    public async Task Hidden_section_skipped()
    {
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler((req) =>
        {
            calls.Add(req.RequestUri!.Query);
            return Respond(HttpStatusCode.OK, SearchResponseOnePr);
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubSectionQueryRunner(http, () => Task.FromResult<string?>("t"));

        await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        calls.Should().HaveCount(1);
    }

    [Fact]
    public async Task Section_failure_records_empty_for_that_section_others_succeed()
    {
        var handler = new FakeHttpMessageHandler((req) =>
        {
            var q = req.RequestUri!.Query;
            return q.Contains("ci-failing", StringComparison.Ordinal) || q.Contains("author%3A%40me", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.OK, SearchResponseOnePr)
                : Respond(HttpStatusCode.InternalServerError, "{}");
        });
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubSectionQueryRunner(http, () => Task.FromResult<string?>("t"));

        var result = await sut.QueryAllAsync(new HashSet<string>
        {
            "review-requested", "authored-by-me", "ci-failing"
        }, default);

        result["authored-by-me"].Should().HaveCount(1);
        result["review-requested"].Should().BeEmpty();
    }

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}
