using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubCiFailingDetectorTests
{
    private static RawPrInboxItem Raw(int n, string headSha = "sha", string repo = "acme/api")
    {
        var parts = repo.Split('/');
        return new RawPrInboxItem(
            new PrReference(parts[0], parts[1], n),
            $"PR #{n}", "author", repo,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            0, 0, 0, headSha, 1);
    }

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private static GitHubCiFailingDetector BuildSut(FakeHttpMessageHandler handler) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"));

    private static FakeHttpMessageHandler RouterHandler(string checkRunsBody, string statusBody)
        => new(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, checkRunsBody);
            if (req.RequestUri!.AbsoluteUri.Contains("/status", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, statusBody);
            return Respond(HttpStatusCode.NotFound, "{}");
        });

    private const string AllPassingCheckRuns = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "completed", "conclusion": "success" },
            { "name": "ci/test",  "status": "completed", "conclusion": "success" }
          ]
        }
        """;

    private const string AllPassingStatus = """{ "state": "success", "statuses": [] }""";

    private const string FailingCheckRun = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "completed", "conclusion": "success" },
            { "name": "ci/test",  "status": "completed", "conclusion": "failure" }
          ]
        }
        """;

    private const string FailureStatus = """{ "state": "failure", "statuses": [] }""";
    private const string ErrorStatus = """{ "state": "error", "statuses": [] }""";
    private const string PendingStatus = """{ "state": "pending", "statuses": [] }""";

    private const string InProgressCheckRun = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "in_progress", "conclusion": null }
          ]
        }
        """;

    [Fact]
    public async Task Failing_check_run_marks_failing()
    {
        var handler = RouterHandler(FailingCheckRun, AllPassingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Should().HaveCount(1);
        result[0].Ci.Should().Be(CiStatus.Failing);
    }

    [Fact]
    public async Task Failure_status_marks_failing()
    {
        var handler = RouterHandler(AllPassingCheckRuns, FailureStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Should().HaveCount(1);
        result[0].Ci.Should().Be(CiStatus.Failing);
    }

    [Fact]
    public async Task Error_status_marks_failing()
    {
        var handler = RouterHandler(AllPassingCheckRuns, ErrorStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Should().HaveCount(1);
        result[0].Ci.Should().Be(CiStatus.Failing);
    }

    [Fact]
    public async Task All_passing_marks_none()
    {
        var handler = RouterHandler(AllPassingCheckRuns, AllPassingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Should().HaveCount(1);
        result[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task All_pending_marks_pending()
    {
        var handler = RouterHandler(InProgressCheckRun, PendingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Should().HaveCount(1);
        result[0].Ci.Should().Be(CiStatus.Pending);
    }

    [Fact]
    public async Task Cache_hit_skips_http()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, AllPassingStatus);
        });
        var sut = BuildSut(handler);

        var candidate = Raw(1, "sha-A");
        await sut.DetectAsync([candidate], default);
        var countAfterFirst = requestCount;
        await sut.DetectAsync([candidate], default);

        // First call: 2 HTTP requests (check-runs + status); second call: zero new requests
        countAfterFirst.Should().Be(2);
        requestCount.Should().Be(2, "second DetectAsync call for same (pr, sha) must hit the cache");
    }

    [Fact]
    public async Task Cache_invalidates_on_head_sha_change()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, AllPassingStatus);
        });
        var sut = BuildSut(handler);

        await sut.DetectAsync([Raw(1, "sha-A")], default);
        await sut.DetectAsync([Raw(1, "sha-B")], default);

        // Two distinct (prRef, headSha) keys → two full probe cycles (2 HTTP calls each)
        requestCount.Should().Be(4, "different headSha keys must each trigger a fresh probe");
    }

    [Fact]
    public async Task Concurrency_capped_at_eight()
    {
        var inFlight = 0;
        var maxObserved = 0;
        var inFlightLock = new object();

        var handler = new FakeHttpMessageHandler(req =>
        {
            var isChecks = req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal);
            if (isChecks)
            {
                lock (inFlightLock)
                {
                    inFlight++;
                    if (inFlight > maxObserved) maxObserved = inFlight;
                }
                Thread.Sleep(10);
                lock (inFlightLock) inFlight--;
            }
            var body = isChecks ? "{\"check_runs\":[]}" : "{\"state\":\"success\"}";
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        });
        var sut = BuildSut(handler);

        var candidates = Enumerable.Range(1, 20)
            .Select(n => Raw(n, headSha: $"head-{n}"))
            .ToList();

        await sut.DetectAsync(candidates, default);

        maxObserved.Should().BeLessThanOrEqualTo(8,
            "the SemaphoreSlim cap of 8 must hold under load (measured at /check-runs)");
    }

    [Fact]
    public async Task Empty_input_returns_empty()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
        });
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([], default);

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
            return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.DetectAsync([Raw(1, "sha1")], cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
