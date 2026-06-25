// tests/PRism.GitHub.Tests/GitHubPrChecksReaderTests.cs
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Contracts;
using PRism.Core.Inbox; // RateLimitExceededException (feasibility R4)
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers; // FakeHttpClientFactory + FakeHttpMessageHandler (feasibility R3)
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubPrChecksReaderTests
{
    private const string Sha = "0123456789abcdef0123456789abcdef01234567";
    private static readonly PrReference Pr = new("o", "r", 1);

    // Uses the established doubles (NOT a non-existent StubHttpClientFactory): the "github"
    // client's BaseAddress must be set so GitHubHttp.ApplyHeaders' same-host guard passes.
    // Mirrors GitHubCiFailingDetectorTests.cs:29.
    private static GitHubPrChecksReader ReaderFor(Func<HttpRequestMessage, HttpResponseMessage> respond)
        => new(
            new FakeHttpClientFactory(new FakeHttpMessageHandler(respond), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("tok"));

    [Fact]
    public async Task Reads_check_runs_and_legacy_statuses_into_one_list()
    {
        var reader = ReaderFor(req =>
        {
            if (req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal))
                return Json(
                    """{"check_runs":[{"name":"build","status":"completed","conclusion":"success","started_at":"2026-06-25T10:00:00Z","completed_at":"2026-06-25T10:01:30Z","details_url":"https://github.com/o/r/runs/1"}]}""");
            // /status with one registered legacy context
            return Json(
                """{"state":"failure","total_count":1,"statuses":[{"context":"ci/legacy","state":"failure","target_url":"https://ci.example.com/9"}]}""");
        });

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Equal(Sha, resp.HeadSha);
        Assert.Equal(DegradedReason.None, resp.Degraded);
        Assert.Equal(2, resp.Checks.Count);
        var run = Assert.Single(resp.Checks, c => c.Source == "check-run");
        Assert.Equal("build", run.Name);
        Assert.Equal(CheckConclusion.Success, run.Conclusion);
        Assert.NotNull(run.StartedAt);
        Assert.Equal("https://github.com/o/r/runs/1", run.DetailsUrl);
        var status = Assert.Single(resp.Checks, c => c.Source == "status");
        Assert.Equal("ci/legacy", status.Name);
        Assert.Equal(CheckConclusion.Failure, status.Conclusion);
        Assert.Null(status.StartedAt); // legacy status carries no timing
    }

    [Fact]
    public async Task Bare_pending_status_with_no_registered_contexts_contributes_nothing_286()
    {
        var reader = ReaderFor(req =>
            req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal)
                ? Json("""{"check_runs":[]}""")
                : Json("""{"state":"pending","total_count":0,"statuses":[]}"""));

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Empty(resp.Checks);
        Assert.Equal(DegradedReason.None, resp.Degraded);
    }

    [Fact]
    public async Task Forbidden_on_check_runs_returns_partial_with_Auth()
    {
        var reader = ReaderFor(req =>
            req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal)
                ? new HttpResponseMessage(HttpStatusCode.Forbidden)
                : Json("""{"state":"success","total_count":1,"statuses":[{"context":"x","state":"success"}]}"""));

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Equal(DegradedReason.Auth, resp.Degraded);
        Assert.Single(resp.Checks); // the legacy status still came through
    }

    [Fact]
    public async Task Both_fail_different_reasons_reports_Auth_before_Transient()
    {
        var reader = ReaderFor(req =>
            new HttpResponseMessage(
                req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal)
                    ? HttpStatusCode.Forbidden
                    : HttpStatusCode.InternalServerError));

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Equal(DegradedReason.Auth, resp.Degraded);
        Assert.Empty(resp.Checks);
    }

    [Fact]
    public async Task Server_error_returns_Transient()
    {
        var reader = ReaderFor(req =>
            req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal)
                ? new HttpResponseMessage(HttpStatusCode.BadGateway)
                : Json("""{"state":"success","total_count":0,"statuses":[]}"""));

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Equal(DegradedReason.Transient, resp.Degraded);
    }

    [Fact]
    public async Task RateLimited_throws()
    {
        var reader = ReaderFor(_ => new HttpResponseMessage(HttpStatusCode.TooManyRequests));
        await Assert.ThrowsAsync<RateLimitExceededException>(
            () => reader.ReadAsync(Pr, Sha, CancellationToken.None));
    }

    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:text/html,x")]
    [InlineData("http://insecure.example.com/run")]
    public async Task Non_https_details_url_is_sanitized_to_null(string raw)
    {
        var reader = ReaderFor(req =>
            req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal)
                ? Json($$"""{"check_runs":[{"name":"x","status":"completed","conclusion":"success","details_url":"{{raw}}"}]}""")
                : Json("""{"state":"success","total_count":0,"statuses":[]}"""));

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Null(Assert.Single(resp.Checks).DetailsUrl);
    }

    [Fact]
    public async Task Walks_rel_next_pages_for_check_runs()
    {
        var page = 0;
        var reader = ReaderFor(req =>
        {
            if (!req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal))
                return Json("""{"state":"success","total_count":0,"statuses":[]}""");
            page++;
            var resp = Json($$"""{"check_runs":[{"name":"c{{page}}","status":"completed","conclusion":"success"}]}""");
            if (page == 1)
                resp.Headers.Add("Link", "<https://api.github.com/repos/o/r/commits/" + Sha + "/check-runs?page=2>; rel=\"next\"");
            return resp;
        });

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        Assert.Equal(2, resp.Checks.Count); // page 1 + page 2 both collected
    }

    private static HttpResponseMessage Json(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body) };
}
