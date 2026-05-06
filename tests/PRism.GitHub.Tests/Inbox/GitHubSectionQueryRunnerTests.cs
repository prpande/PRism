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
    private static GitHubSectionQueryRunner BuildSut(FakeHttpMessageHandler handler) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"));
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
        var sut = BuildSut(handler);

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
        var sut = BuildSut(handler);

        await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        calls.Should().HaveCount(1);
    }

    [Fact]
    public async Task Section_failure_records_empty_for_that_section_others_succeed()
    {
        // First two requests succeed, remaining requests fail. The runner fires
        // section queries in parallel; we use a request counter rather than query-
        // string routing because some sections share identical query strings
        // (authored-by-me and ci-failing both encode to author%3A%40me).
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler((req) =>
        {
            var idx = Interlocked.Increment(ref requestCount);
            return idx <= 2
                ? Respond(HttpStatusCode.OK, SearchResponseOnePr)
                : Respond(HttpStatusCode.InternalServerError, "{}");
        });
        var sut = BuildSut(handler);

        var result = await sut.QueryAllAsync(new HashSet<string>
        {
            "review-requested", "awaiting-author", "authored-by-me", "mentioned", "ci-failing"
        }, default);

        result.Should().HaveCount(5); // every requested section is in the result
        var nonEmpty = result.Where(kv => kv.Value.Count > 0).ToList();
        var empty = result.Where(kv => kv.Value.Count == 0).ToList();
        nonEmpty.Should().HaveCount(2); // first two responses succeeded
        empty.Should().HaveCount(3); // remaining three failed
    }

    [Fact]
    public async Task Rate_limit_429_propagates_as_typed_exception()
    {
        var handler = new FakeHttpMessageHandler((req) =>
        {
            var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
            resp.Headers.Add("Retry-After", "60");
            return resp;
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.QueryAllAsync(
            new HashSet<string> { "review-requested" }, default);

        await act.Should().ThrowAsync<RateLimitExceededException>();
    }

    [Fact]
    public async Task Cancellation_propagates_does_not_swallow()
    {
        // Use a handler that explicitly throws OCE when the token is cancelled,
        // because HttpClient.SendAsync does not synchronously check a pre-cancelled
        // token before dispatching to the inner handler on all .NET versions.
        using var cts = new CancellationTokenSource();
        cts.Cancel(); // pre-cancelled

        var handler = new FakeHttpMessageHandler((req) =>
        {
            cts.Token.ThrowIfCancellationRequested();
            return Respond(HttpStatusCode.OK, SearchResponseOnePr);
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.QueryAllAsync(
            new HashSet<string> { "review-requested" }, cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}
