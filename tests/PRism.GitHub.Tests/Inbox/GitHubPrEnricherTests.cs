using System.Globalization;
using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubPrEnricherTests
{
    private static RawPrInboxItem Raw(int n, DateTimeOffset? updatedAt = null, string repo = "acme/api")
    {
        var parts = repo.Split('/');
        var ts = updatedAt ?? DateTimeOffset.UtcNow;
        return new RawPrInboxItem(
            new PrReference(parts[0], parts[1], n),
            $"PR #{n}", "author", repo,
            ts, ts,
            0, 0, 0, "", 1);
    }

    private const string PullsResponse = """
        {
          "head": {
            "sha": "abc123",
            "repo": { "pushed_at": "2026-05-06T09:50:00Z" }
          },
          "additions": 5,
          "deletions": 2,
          "commits": 3,
          "updated_at": "2026-05-06T10:00:00Z"
        }
        """;

    private static HttpResponseMessage Respond(HttpStatusCode code, string body)
        => JsonHttpResponse.Create(code, body);

    private static GitHubPrEnricher BuildSut(FakeHttpMessageHandler handler) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"));

    [Fact]
    public async Task Adds_head_sha_and_diff_stats()
    {
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, PullsResponse));
        var sut = BuildSut(handler);

        var result = await sut.EnrichAsync([Raw(1)], default);

        result.Should().HaveCount(1);
        var item = result[0];
        item.HeadSha.Should().Be("abc123");
        item.Additions.Should().Be(5);
        item.Deletions.Should().Be(2);
        item.CommitCount.Should().Be(3);
        item.PushedAt.Should().Be(DateTimeOffset.Parse("2026-05-06T09:50:00Z", CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task Cache_hit_skips_http()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        var item = Raw(1, updatedAt: DateTimeOffset.Parse("2026-05-06T10:00:00Z", CultureInfo.InvariantCulture));
        await sut.EnrichAsync([item], default);
        await sut.EnrichAsync([item], default);

        requestCount.Should().Be(1);
    }

    [Fact]
    public async Task Cache_invalidates_on_updated_change()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        var item1 = Raw(1, updatedAt: DateTimeOffset.Parse("2026-05-06T10:00:00Z", CultureInfo.InvariantCulture));
        var item2 = Raw(1, updatedAt: DateTimeOffset.Parse("2026-05-06T11:00:00Z", CultureInfo.InvariantCulture)); // same PR, later timestamp
        await sut.EnrichAsync([item1], default);
        await sut.EnrichAsync([item2], default);

        requestCount.Should().Be(2);
    }

    [Fact]
    public async Task Pr_404_drops_pr_from_result()
    {
        var handler = new FakeHttpMessageHandler(_ =>
            new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            });
        var sut = BuildSut(handler);

        var result = await sut.EnrichAsync([Raw(1)], default);

        result.Should().BeEmpty();
    }

    [Fact]
    public async Task Concurrency_capped_at_eight()
    {
        var inFlight = 0;
        var maxObserved = 0;
        var inFlightLock = new object();

        var handler = new FakeHttpMessageHandler(_ =>
        {
            lock (inFlightLock)
            {
                inFlight++;
                if (inFlight > maxObserved) maxObserved = inFlight;
            }
            Thread.Sleep(10);
            lock (inFlightLock) inFlight--;

            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        // 20 distinct PRs to exceed the cap
        var items = Enumerable.Range(1, 20)
            .Select(n => Raw(n, updatedAt: DateTimeOffset.UtcNow.AddSeconds(-n)))
            .ToList();

        await sut.EnrichAsync(items, default);

        maxObserved.Should().BeLessThanOrEqualTo(8,
            "the SemaphoreSlim cap of 8 must hold under load");
    }

    [Fact]
    public async Task Empty_input_returns_empty()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        var result = await sut.EnrichAsync([], default);

        result.Should().BeEmpty();
        requestCount.Should().Be(0);
    }

    [Fact]
    public async Task Cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel(); // pre-cancelled

        var handler = new FakeHttpMessageHandler(_ =>
        {
            cts.Token.ThrowIfCancellationRequested();
            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.EnrichAsync([Raw(1)], cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task FetchAsync_throws_RateLimitExceededException_on_429_with_RetryAfter()
    {
        // pulls/{n} returns 429 with Retry-After: 30. Without an explicit 429 check
        // the response would flow into EnsureSuccessStatusCode() and surface as a
        // generic HttpRequestException — the poller's Retry-After-aware handler
        // never fires. Spec § 10 requires Retry-After honored on every 429.
        var handler = new FakeHttpMessageHandler(_ =>
        {
            var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
            resp.Headers.Add("Retry-After", "30");
            return resp;
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.EnrichAsync([Raw(1)], default);

        var ex = (await act.Should().ThrowAsync<RateLimitExceededException>()).Which;
        ex.RetryAfter.Should().Be(TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task PushedAt_falls_back_to_updatedAt_when_head_repo_is_null()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            requestCount++;
            var body = """
                {
                  "head": { "sha": "xyz", "repo": null },
                  "additions": 0,
                  "deletions": 0,
                  "commits": 1,
                  "updated_at": "2026-05-06T11:00:00Z"
                }
                """;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        });
        var sut = BuildSut(handler);
        var input = new[] { Raw(1, updatedAt: DateTimeOffset.Parse("2026-05-06T10:30:00Z", CultureInfo.InvariantCulture)) };

        var result = await sut.EnrichAsync(input, default);

        result[0].PushedAt.Should().Be(DateTimeOffset.Parse("2026-05-06T10:30:00Z", CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task Preserves_avatar_url_through_enrichment()
    {
        // The enricher returns `raw with { ... }` overriding only HeadSha / diff-stat /
        // timestamp fields. AvatarUrl is NOT in the override list, so the `with`
        // expression must carry it through unchanged. This locks the inbox avatar path
        // (#127) against a future refactor that reconstructs the record positionally and
        // silently drops the trailing AvatarUrl.
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, PullsResponse));
        var sut = BuildSut(handler);
        var raw = new RawPrInboxItem(
            new PrReference("acme", "api", 1),
            "PR #1", "author", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            0, 0, 0, "", 1,
            AvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4");

        var result = await sut.EnrichAsync([raw], default);

        result.Should().ContainSingle();
        result[0].AvatarUrl.Should().Be("https://avatars.githubusercontent.com/u/1?v=4");
        result[0].HeadSha.Should().Be("abc123"); // enrichment still applied alongside
    }

    [Fact]
    public async Task Malformed_pr_detail_is_dropped_other_prs_still_enriched()
    {
        // PR 1 returns a body missing "head"; PR 2 returns a valid body. PR 1 is dropped,
        // PR 2 survives — one poisoned PR detail must not abort the whole enrich tick.
        var handler = new FakeHttpMessageHandler(req =>
        {
            var isPr1 = req.RequestUri!.AbsolutePath.EndsWith("/pulls/1", StringComparison.Ordinal);
            return Respond(HttpStatusCode.OK, isPr1 ? """{"additions":1}""" : PullsResponse);
        });
        var sut = BuildSut(handler);

        var result = await sut.EnrichAsync([Raw(1), Raw(2)], default);

        result.Should().ContainSingle();
        result[0].Reference.Number.Should().Be(2);
    }

    [Fact]
    public async Task Transient_5xx_on_one_pr_still_propagates()
    {
        // A 5xx is a transport failure, NOT a malformed item — it must propagate (the JSON
        // guard does not swallow it), so the poller can skip and retry the whole tick.
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.InternalServerError, "{}"));
        var sut = BuildSut(handler);

        var act = async () => await sut.EnrichAsync([Raw(1)], default);

        await act.Should().ThrowAsync<HttpRequestException>();
    }

    [Fact]
    public async Task Evicts_absent_pr_cache_entry_observed_on_reinclusion()
    {
        // Hold UpdatedAt constant across ticks so a re-probe can only be explained by eviction
        // (not a changed cache key (Reference, UpdatedAt)).
        var fixedTs = new DateTimeOffset(2026, 5, 6, 10, 0, 0, TimeSpan.Zero);
        var perUrl = new Dictionary<string, int>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var key = req.RequestUri!.AbsolutePath;
            perUrl[key] = perUrl.TryGetValue(key, out var v) ? v + 1 : 1;
            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        var pr1 = Raw(1, fixedTs); var pr2 = Raw(2, fixedTs);
        await sut.EnrichAsync([pr1, pr2], default);
        await sut.EnrichAsync([pr1], default);
        await sut.EnrichAsync([pr1, pr2], default);

        perUrl["/repos/acme/api/pulls/1"].Should().Be(1);
        perUrl["/repos/acme/api/pulls/2"].Should().Be(2);
    }
}
