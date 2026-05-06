using System.Net;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewService_ValidateCredentialsAsyncTests
{
    private static GitHubReviewService BuildSut(HttpMessageHandler handler, string token = "ghp_test", string host = "https://github.com")
    {
        var client = new HttpClient(handler) { BaseAddress = HostUrlResolver.ApiBase(host) };
        return new GitHubReviewService(client, () => Task.FromResult<string?>(token), host);
    }

    [Fact]
    public async Task Returns_ok_with_login_and_scopes_on_200()
    {
        var headers = new Dictionary<string, string> { ["X-OAuth-Scopes"] = "repo, read:user, read:org" };
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.OK, "{\"login\":\"octocat\"}", headers);
        var sut = BuildSut(handler);

        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);

        result.Ok.Should().BeTrue();
        result.Login.Should().Be("octocat");
        result.Scopes.Should().BeEquivalentTo(new[] { "repo", "read:user", "read:org" });
    }

    [Fact]
    public async Task Returns_invalid_token_on_401()
    {
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.Unauthorized, "{\"message\":\"Bad credentials\"}");
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.InvalidToken);
    }

    [Fact]
    public async Task Returns_insufficient_scopes_on_403_when_required_scope_missing()
    {
        var headers = new Dictionary<string, string> { ["X-OAuth-Scopes"] = "repo" };
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.OK, "{\"login\":\"octocat\"}", headers);
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.InsufficientScopes);
        result.ErrorDetail.Should().Contain("read:user").And.Contain("read:org");
    }

    [Fact]
    public async Task Returns_server_error_on_5xx()
    {
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.InternalServerError);
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.ServerError);
    }

    [Fact]
    public async Task Returns_dns_error_when_handler_throws_dns_exception()
    {
        var handler = FakeHttpMessageHandler.Throws(new HttpRequestException("Name or service not known", new System.Net.Sockets.SocketException(11001)));
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.DnsError);
    }

    [Fact]
    public async Task Returns_network_error_on_generic_HttpRequestException()
    {
        var handler = FakeHttpMessageHandler.Throws(new HttpRequestException("connection refused"));
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.NetworkError);
    }

    [Fact]
    public async Task Returns_server_error_when_200_body_is_not_json()
    {
        // GitHub-side intermediaries (proxies, captive portals, GHES misconfig) can return
        // 200 with HTML or otherwise malformed body. JsonDocument.Parse must not escape as 500.
        var headers = new Dictionary<string, string> { ["X-OAuth-Scopes"] = "repo, read:user, read:org" };
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.OK, "<html>captive portal</html>", headers);
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.ServerError);
        result.ErrorDetail.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task Returns_ok_for_fine_grained_pat_with_no_scopes_header()
    {
        // Fine-grained PATs do not return X-OAuth-Scopes. The validator must accept them.
        // Search probe is stubbed to return >0 results so no warning is raised in this test.
        var firstCall = true;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (firstCall)
            {
                firstCall = false;
                return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"login\":\"octocat\"}", System.Text.Encoding.UTF8, "application/json"),
                };
            }
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"total_count\":1,\"items\":[]}", System.Text.Encoding.UTF8, "application/json"),
            };
        });
        var sut = BuildSut(handler, token: "github_pat_abcDEF123_xyz");
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeTrue();
        result.Login.Should().Be("octocat");
        result.Warning.Should().Be(AuthValidationWarning.None);
    }

    [Fact]
    public async Task Probe_non_5xx_failure_fails_open_and_returns_primary_success()
    {
        // When /user succeeds but the Search probe returns a non-5xx error (e.g. 403),
        // the validator must fail open: return Ok=true with Warning=None rather than NetworkError.
        // The credential is valid; the probe anomaly should not reject a valid token.
        var calls = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            calls++;
            if (calls == 1)
            {
                return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"login\":\"octocat\"}", System.Text.Encoding.UTF8, "application/json"),
                };
            }
            // Probe returns 403 — EnsureSuccessStatusCode throws HttpRequestException with StatusCode=403.
            return new HttpResponseMessage(System.Net.HttpStatusCode.Forbidden);
        });
        var sut = BuildSut(handler, token: "github_pat_probe_403");
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeTrue();
        result.Login.Should().Be("octocat");
        result.Warning.Should().Be(AuthValidationWarning.None);
    }
}
