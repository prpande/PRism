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
        BuildSut(handler, () => DateTimeOffset.UtcNow);

    private static GitHubSectionQueryRunner BuildSut(
        FakeHttpMessageHandler handler, Func<DateTimeOffset> clock) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"),
            clock);
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
        // ci-failing is NOT a Search query — the orchestrator derives it from the
        // authored-by-me superset using ICiFailingDetector. Only 4 calls should fire.
        calls.Should().HaveCount(4);
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
    public async Task QueryAllAsync_does_not_fire_a_search_for_ci_failing_when_only_ci_failing_is_visible()
    {
        // Regression: "ci-failing" used to be mapped in SectionQueries to the same query
        // string as "authored-by-me" (`is:open is:pr author:@me archived:false`). The
        // orchestrator overwrites the ci-failing entry with the CI-detector-filtered subset
        // of authored-by-me, so the Search API call for ci-failing was discarded every tick —
        // a wasted hit against GitHub's 30-rpm Search secondary rate limit.
        // The runner must NOT fire a Search query for "ci-failing"; the orchestrator's
        // CI fan-out block populates that section from the authored-by-me superset.
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler((req) =>
        {
            calls.Add(req.RequestUri!.Query);
            return Respond(HttpStatusCode.OK, SearchResponseOnePr);
        });
        var sut = BuildSut(handler);

        var result = await sut.QueryAllAsync(new HashSet<string> { "ci-failing" }, default);

        calls.Should().BeEmpty(
            "ci-failing must be derived from authored-by-me by the orchestrator, not fetched separately");
        result.Should().NotContainKey("ci-failing");
    }

    [Fact]
    public async Task Section_failure_records_empty_for_that_section_others_succeed()
    {
        // First two requests succeed, remaining requests fail. The runner fires
        // section queries in parallel. ci-failing is NOT in SectionQueries (the orchestrator
        // derives it from authored-by-me), so only 4 sections fire HTTP requests even when
        // the visible set requests 5.
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

        result.Should().HaveCount(4); // ci-failing is not queried; 4 sections in the result
        result.Should().NotContainKey("ci-failing");
        var nonEmpty = result.Where(kv => kv.Value.Count > 0).ToList();
        var empty = result.Where(kv => kv.Value.Count == 0).ToList();
        nonEmpty.Should().HaveCount(2); // first two responses succeeded
        empty.Should().HaveCount(2); // remaining two failed
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

    [Fact]
    public async Task Item_with_malformed_pr_url_is_skipped_other_items_still_returned()
    {
        // A response that mixes an invalid html_url with a valid one.
        // The malformed item must be silently skipped; the valid item must still be returned.
        const string mixedResponse = """
            {
              "items": [
                {
                  "number": 99,
                  "title": "Bad URL PR",
                  "user": { "login": "amelia" },
                  "repository_url": "https://api.github.com/repos/acme/api",
                  "updated_at": "2026-05-06T10:00:00Z",
                  "comments": 0,
                  "pull_request": { "html_url": "not-a-valid-url" }
                },
                {
                  "number": 42,
                  "title": "Good PR",
                  "user": { "login": "amelia" },
                  "repository_url": "https://api.github.com/repos/acme/api",
                  "updated_at": "2026-05-06T10:00:00Z",
                  "comments": 3,
                  "pull_request": { "html_url": "https://github.com/acme/api/pull/42" }
                }
              ]
            }
            """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, mixedResponse));
        var sut = BuildSut(handler);

        var result = await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        var items = result["review-requested"];
        items.Should().HaveCount(1, "the malformed-URL item must be silently skipped");
        items[0].Reference.Number.Should().Be(42);
    }

    [Fact]
    public async Task QueryClosedHistory_FiresBothSubQueries_WithCutoff_AndDedupesByRef()
    {
        // clock = 2026-06-02; windowDays 14 => cutoff 2026-05-19.
        // involves query returns PRs [1, 2]; reviewed-by query returns [1, 3].
        // Shared PR #1 must be deduped; result == {1, 2, 3}.
        var clock = () => new DateTimeOffset(2026, 6, 2, 12, 0, 0, TimeSpan.Zero);

        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler((req) =>
        {
            var query = req.RequestUri!.Query;
            calls.Add(query);
            var decoded = Uri.UnescapeDataString(query);
            // The involves sub-query gets [1, 2]; the reviewed-by sub-query gets [1, 3].
            var body = decoded.Contains("involves:@me", StringComparison.Ordinal)
                ? SearchResponseWithNumbers(1, 2)
                : SearchResponseWithNumbers(1, 3);
            return Respond(HttpStatusCode.OK, body);
        });
        var sut = BuildSut(handler, clock);

        var result = await sut.QueryClosedHistoryAsync(14, default);

        calls.Should().HaveCount(2);
        var decodedCalls = calls.Select(Uri.UnescapeDataString).ToList();
        decodedCalls.Should().ContainSingle(q => q.Contains("involves:@me", StringComparison.Ordinal));
        decodedCalls.Should().ContainSingle(q => q.Contains("reviewed-by:@me", StringComparison.Ordinal));
        decodedCalls.Should().OnlyContain(q => q.Contains("closed:>=2026-05-19", StringComparison.Ordinal));
        decodedCalls.Should().OnlyContain(q => q.Contains("is:closed", StringComparison.Ordinal));

        result.Select(r => r.Reference.Number).Should().BeEquivalentTo(new[] { 1, 2, 3 });
    }

    [Fact]
    public async Task QueryClosedHistory_RequestsUpdatedDescSort()
    {
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            calls.Add(req.RequestUri!.Query);
            return Respond(HttpStatusCode.OK, """{ "items": [] }""");
        });
        var sut = BuildSut(handler);

        await sut.QueryClosedHistoryAsync(14, default);

        calls.Should().NotBeEmpty();
        calls.Should().OnlyContain(q => q.Contains("sort=updated") && q.Contains("order=desc"));
    }

    [Fact]
    public async Task QueryClosedHistory_OneSubQueryFails_ReturnsOtherSubQuerysResults()
    {
        // Per-sub-query failure isolation (mirrors QueryAllAsync's Section_failure test):
        // the involves:@me sub-query returns HTTP 500 (a non-RateLimit/non-Cancellation
        // error → caught and yields empty), while reviewed-by:@me succeeds with PR #5.
        // QueryClosedHistoryAsync must NOT throw; the result contains ONLY PR #5.
        var clock = () => new DateTimeOffset(2026, 6, 2, 12, 0, 0, TimeSpan.Zero);

        var handler = new FakeHttpMessageHandler((req) =>
        {
            var decoded = Uri.UnescapeDataString(req.RequestUri!.Query);
            return decoded.Contains("involves:@me", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.InternalServerError, "{}")
                : Respond(HttpStatusCode.OK, SearchResponseWithNumbers(5));
        });
        var sut = BuildSut(handler, clock);

        var result = await sut.QueryClosedHistoryAsync(14, default);

        result.Select(r => r.Reference.Number).Should().BeEquivalentTo(new[] { 5 },
            "the failed involves:@me sub-query must yield empty without throwing, leaving only the reviewed-by:@me result");
    }

    [Fact]
    public async Task Search_carries_user_avatar_url_to_raw_item()
    {
        const string body = """
        {
          "items": [
            {
              "number": 42,
              "title": "Test PR",
              "user": { "login": "amelia", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4" },
              "repository_url": "https://api.github.com/repos/acme/api",
              "updated_at": "2026-05-06T10:00:00Z",
              "comments": 3,
              "pull_request": { "html_url": "https://github.com/acme/api/pull/42" }
            }
          ]
        }
        """;
        var handler = new FakeHttpMessageHandler((_) => Respond(HttpStatusCode.OK, body));
        var sut = BuildSut(handler);

        var result = await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        result["review-requested"].Single().AvatarUrl
            .Should().Be("https://avatars.githubusercontent.com/u/1?v=4");
    }

    private static string SearchResponseWithNumbers(params int[] numbers)
    {
        var items = numbers.Select(n => $$"""
            {
              "number": {{n}},
              "title": "PR {{n}}",
              "user": { "login": "amelia" },
              "repository_url": "https://api.github.com/repos/acme/api",
              "updated_at": "2026-05-06T10:00:00Z",
              "comments": 0,
              "pull_request": { "html_url": "https://github.com/acme/api/pull/{{n}}" }
            }
            """);
        return $$"""{ "items": [ {{string.Join(",", items)}} ] }""";
    }

    [Fact]
    public async Task One_malformed_item_is_skipped_section_keeps_the_good_item()
    {
        // items[] has one valid PR and one missing pull_request.html_url / title.
        const string mixed = """
        {
          "items": [
            {
              "number": 7, "title": "Good PR",
              "user": { "login": "amelia" },
              "updated_at": "2026-05-06T10:00:00Z",
              "comments": 1,
              "pull_request": { "html_url": "https://github.com/acme/api/pull/7" }
            },
            { "number": 8, "user": {} }
          ]
        }
        """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, mixed));
        var sut = BuildSut(handler);

        var result = await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        result["review-requested"].Should().ContainSingle();
        result["review-requested"][0].Reference.Number.Should().Be(7);
    }

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}
