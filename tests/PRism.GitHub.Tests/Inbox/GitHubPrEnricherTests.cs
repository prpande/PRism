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

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private static GitHubPrEnricher BuildSut(FakeHttpMessageHandler handler)
    {
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        return new GitHubPrEnricher(http, () => Task.FromResult<string?>("t"));
    }

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
        item.IterationNumberApprox.Should().Be(3);
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
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubPrEnricher(http, () => Task.FromResult<string?>("t"));
        var input = new[] { Raw(1, updatedAt: DateTimeOffset.Parse("2026-05-06T10:30:00Z", CultureInfo.InvariantCulture)) };

        var result = await sut.EnrichAsync(input, default);

        result[0].PushedAt.Should().Be(DateTimeOffset.Parse("2026-05-06T10:30:00Z", CultureInfo.InvariantCulture));
    }
}
