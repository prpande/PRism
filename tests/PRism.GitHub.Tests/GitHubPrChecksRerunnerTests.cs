using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubPrChecksRerunnerTests
{
    private const string Sha = "0123456789abcdef0123456789abcdef01234567";
    private static readonly PrReference Pr = new("o", "r", 1);
    private const long CheckRunId = 555;

    // Records each request path so a test can assert the rerequest POST did / did not fire.
    private sealed class Recorder
    {
        public readonly System.Collections.Generic.List<(HttpMethod Method, string Path)> Calls = new();
    }

    private static (GitHubPrChecksRerunner Rerunner, Recorder Rec) RerunnerFor(
        Func<HttpRequestMessage, HttpResponseMessage> respond)
    {
        var rec = new Recorder();
        var rerunner = new GitHubPrChecksRerunner(
            new FakeHttpClientFactory(
                new FakeHttpMessageHandler(req =>
                {
                    rec.Calls.Add((req.Method, req.RequestUri!.AbsolutePath));
                    return respond(req);
                }),
                new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("tok"));
        return (rerunner, rec);
    }

    private static HttpResponseMessage Json(HttpStatusCode code, string body) =>
        new(code) { Content = new StringContent(body) };

    private static bool IsGet(HttpRequestMessage r) => r.Method == HttpMethod.Get;

    [Fact]
    public async Task Matching_head_sha_reruns_and_returns_accepted()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            IsGet(req)
                ? Json(HttpStatusCode.OK, $$"""{"id":{{CheckRunId}},"head_sha":"{{Sha}}"}""")
                : Json(HttpStatusCode.Created, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Accepted, result.Outcome);
        Assert.Contains(rec.Calls, c => c.Method == HttpMethod.Post && c.Path.EndsWith("/rerequest", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Mismatched_head_sha_returns_superseded_and_does_NOT_rerequest()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            Json(HttpStatusCode.OK, """{"id":555,"head_sha":"ffffffffffffffffffffffffffffffffffffffff"}"""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Superseded, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, RerunOutcome.Auth)]
    [InlineData(HttpStatusCode.Forbidden, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.NotFound, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.UnprocessableEntity, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.InternalServerError, RerunOutcome.Transient)]
    public async Task Get_failure_maps_to_outcome_without_rerequest(HttpStatusCode code, RerunOutcome expected)
    {
        var (rerunner, rec) = RerunnerFor(_ => Json(code, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(expected, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task Rerequest_500_maps_to_transient()
    {
        var (rerunner, _) = RerunnerFor(req =>
            IsGet(req)
                ? Json(HttpStatusCode.OK, $$"""{"id":555,"head_sha":"{{Sha}}"}""")
                : Json(HttpStatusCode.InternalServerError, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Transient, result.Outcome);
    }

    [Fact]
    public async Task Network_exception_maps_to_transient()
    {
        var rerunner = new GitHubPrChecksRerunner(
            new FakeHttpClientFactory(
                new FakeHttpMessageHandler(_ => throw new HttpRequestException("boom")),
                new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("tok"));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Transient, result.Outcome);
    }
}
