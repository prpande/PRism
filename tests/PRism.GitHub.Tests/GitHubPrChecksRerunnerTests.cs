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
    private const long JobId = 999; // deliberately != CheckRunId so a jobs-API assert proves details_url parsing

    // A GitHub Actions check-run: re-runs via the Actions jobs API. details_url carries the job id.
    private static string ActionsJson(string sha = Sha, bool withDetailsUrl = true)
    {
        var details = withDetailsUrl
            ? $$""","details_url":"https://github.com/o/r/actions/runs/12/job/{{JobId}}" """
            : "";
        return $$"""{"id":{{CheckRunId}},"head_sha":"{{sha}}","app":{"slug":"github-actions"}{{details}}}""";
    }

    // A third-party GitHub App check-run: re-runs via check-runs/{id}/rerequest.
    private static string AppJson(string sha = Sha) =>
        $$"""{"id":{{CheckRunId}},"head_sha":"{{sha}}","app":{"slug":"some-ci-app"},"details_url":"https://ci.example.com/run/1"}""";

    // Records each request path so a test can assert which POST endpoint fired (or that none did).
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
    public async Task Actions_check_run_reruns_via_jobs_api_and_returns_accepted()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            IsGet(req) ? Json(HttpStatusCode.OK, ActionsJson()) : Json(HttpStatusCode.Created, "{}"));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Accepted, result.Outcome);
        // Job id comes from details_url (999), NOT the check-run id (555) — proves we parse the URL.
        Assert.Contains(rec.Calls, c => c.Method == HttpMethod.Post
            && c.Path.EndsWith($"/actions/jobs/{JobId}/rerun", StringComparison.Ordinal));
        Assert.DoesNotContain(rec.Calls, c => c.Path.EndsWith("/rerequest", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Actions_job_id_falls_back_to_check_run_id_when_details_url_missing()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            IsGet(req) ? Json(HttpStatusCode.OK, ActionsJson(withDetailsUrl: false)) : Json(HttpStatusCode.Created, "{}"));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Accepted, result.Outcome);
        Assert.Contains(rec.Calls, c => c.Method == HttpMethod.Post
            && c.Path.EndsWith($"/actions/jobs/{CheckRunId}/rerun", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Third_party_app_check_run_reruns_via_rerequest_and_returns_accepted()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            IsGet(req) ? Json(HttpStatusCode.OK, AppJson()) : Json(HttpStatusCode.Created, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Accepted, result.Outcome);
        Assert.Contains(rec.Calls, c => c.Method == HttpMethod.Post
            && c.Path.EndsWith($"/check-runs/{CheckRunId}/rerequest", StringComparison.Ordinal));
        Assert.DoesNotContain(rec.Calls, c => c.Path.Contains("/actions/jobs/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Mismatched_head_sha_returns_superseded_and_does_NOT_post()
    {
        var (rerunner, rec) = RerunnerFor(_ =>
            Json(HttpStatusCode.OK, ActionsJson(sha: "ffffffffffffffffffffffffffffffffffffffff")));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Superseded, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task Get_response_missing_head_sha_returns_transient_and_does_NOT_post()
    {
        // A 2xx GET whose body has no head_sha is malformed, not "superseded" — must NOT
        // surface the "PR was updated" note, and must not rerun.
        var (rerunner, rec) = RerunnerFor(req =>
            IsGet(req) ? Json(HttpStatusCode.OK, "{}") : Json(HttpStatusCode.Created, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Transient, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, RerunOutcome.Auth)]
    [InlineData(HttpStatusCode.Forbidden, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.NotFound, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.UnprocessableEntity, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.InternalServerError, RerunOutcome.Transient)]
    public async Task Get_failure_maps_to_outcome_without_post(HttpStatusCode code, RerunOutcome expected)
    {
        var (rerunner, rec) = RerunnerFor(_ => Json(code, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(expected, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, RerunOutcome.Auth)]
    [InlineData(HttpStatusCode.Forbidden, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.NotFound, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.UnprocessableEntity, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.InternalServerError, RerunOutcome.Transient)]
    public async Task Rerun_post_failure_maps_to_outcome(HttpStatusCode postCode, RerunOutcome expected)
    {
        var (rerunner, _) = RerunnerFor(req =>
            IsGet(req) ? Json(HttpStatusCode.OK, ActionsJson()) : Json(postCode, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(expected, result.Outcome);
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
