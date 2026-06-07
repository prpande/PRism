using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Feedback;
using PRism.GitHub.Feedback;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Feedback;

public class GitHubFeedbackSubmitterTests
{
    private static readonly FeedbackContent Content =
        new("Bug", "It broke", "Steps: do X", "/pr/:owner/:repo/:number", "desktop", "0.2.0",
            DateTimeOffset.Parse("2026-06-06T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture));

    // Fix 1: NewSubmitter accepts Func<string?> for the host so it mirrors the
    // late-binding pattern of the production DI registration.
    private static GitHubFeedbackSubmitter NewSubmitter(HttpMessageHandler handler, Func<string?>? readHost = null) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("ghp_test"),
            readHost ?? (() => "https://github.com"));

    [Fact]
    public async Task Posts_to_api_github_com_issues_with_title_body_and_context()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created,
            """{"number":12,"html_url":"https://github.com/prpande/PRism-feedback/issues/12"}""");
        var sut = NewSubmitter(handler);

        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);

        handler.RequestMethods[0].Should().Be(HttpMethod.Post);
        handler.RequestPaths[0].Should().Be("/repos/prpande/PRism-feedback/issues");
        using var doc = JsonDocument.Parse(handler.RequestBodies[0]!);
        doc.RootElement.GetProperty("title").GetString().Should().StartWith("[Bug] It broke");
        var body = doc.RootElement.GetProperty("body").GetString()!;
        body.Should().Contain("Steps: do X");
        body.Should().Contain("route: /pr/:owner/:repo/:number");
        body.Should().Contain("version: 0.2.0");
        body.Should().Contain("submitted: 2026-06-06T12:00:00");
        doc.RootElement.TryGetProperty("labels", out _).Should().BeFalse(); // labels omitted (D3)
        result.Outcome.Should().Be(FeedbackOutcome.Created);
        result.IssueNumber.Should().Be(12);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.UnprocessableEntity)]
    public async Task Maps_401_403_404_422_to_CannotCreate(HttpStatusCode status)
    {
        var sut = NewSubmitter(new RecordingHttpMessageHandler(status, """{"message":"no"}"""));
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
    }

    [Fact]
    public async Task Throws_on_5xx()
    {
        var sut = NewSubmitter(new RecordingHttpMessageHandler(HttpStatusCode.InternalServerError, "boom"));
        var act = () => sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        await act.Should().ThrowAsync<HttpRequestException>();
    }

    [Fact]
    public async Task Drops_non_https_html_url_defensively()
    {
        var sut = NewSubmitter(new RecordingHttpMessageHandler(
            HttpStatusCode.Created, """{"number":5,"html_url":"javascript:alert(1)"}"""));
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.HtmlUrl.Should().BeEmpty(); // frontend will hide the Open-in-GitHub link
    }

    [Fact]
    public async Task Non_github_com_host_short_circuits_without_calling_github()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, "{}");
        var sut = NewSubmitter(handler, readHost: () => "https://ghe.corp.example");
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
        handler.RequestCount.Should().Be(0); // PAT never sent to api.github.com
    }

    // Fix 5 — host-spoof Theory: each variant must yield CannotCreate with no HTTP
    // call (PAT never leaves the process). http://github.com is now rejected by the
    // https-scheme guard (Fix 2).
    [Theory]
    [InlineData("https://github.com.evil.com")]    // subdomain takeover look-alike
    [InlineData("https://evil.github.com")]        // github.com is the TLD, not the host
    [InlineData("https://github.com@evil.com")]    // userinfo trick — Uri.Host is evil.com
    [InlineData("http://github.com")]              // http scheme rejected (Fix 2)
    public async Task Host_spoof_short_circuits_without_calling_github(string spoofedHost)
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, "{}");
        var sut = NewSubmitter(handler, readHost: () => spoofedHost);
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
        handler.RequestCount.Should().Be(0, "PAT must never be sent for spoofed host: {0}", spoofedHost);
    }

    // Fix 7a — non-JSON 2xx (proxy HTML page) must NOT throw; must return CannotCreate.
    [Fact]
    public async Task Non_json_2xx_body_returns_CannotCreate_without_throwing()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created,
            "<html><body>Proxy error</body></html>");
        var sut = NewSubmitter(handler);
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
    }

    // Fix 7b — 2xx JSON missing "number" (or number == 0) must return CannotCreate
    // so the frontend falls back to the prefilled link rather than showing issue #0.
    [Theory]
    [InlineData("""{"html_url":"https://github.com/x/y/issues/1"}""")]  // number absent
    [InlineData("""{"number":0,"html_url":"https://github.com/x/y/issues/0"}""")]  // number == 0
    public async Task Missing_or_zero_issue_number_returns_CannotCreate(string responseJson)
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, responseJson);
        var sut = NewSubmitter(handler);
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
    }
}
