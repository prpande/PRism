using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class AuthEndpointsTests
{
    [Fact]
    public async Task State_returns_hasToken_false_initially()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.HasToken.Should().BeFalse();
        resp.HostMismatch.Should().BeNull();
    }

    [Fact]
    public async Task State_returns_configured_github_host()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.Host.Should().Be("https://github.com");
    }

    [Fact]
    public async Task Connect_with_invalid_PAT_returns_ok_false_with_error()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.")),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "ghp_bad" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeFalse();
        body.Error.Should().Be("invalidtoken");      // enum.ToString().ToLowerInvariant()
    }

    [Fact]
    public async Task Connect_with_valid_PAT_returns_ok_true_and_sets_lastConfiguredGithubHost()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(true, "octocat", new[] { "repo", "read:user", "read:org" }, AuthValidationError.None, null)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "ghp_good" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeTrue();
        body.Login.Should().Be("octocat");
    }

    [Fact]
    public async Task Connect_with_malformed_json_body_returns_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(System.UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = new StringContent("not json", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task HostChangeResolution_with_malformed_json_body_returns_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(System.UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/host-change-resolution", UriKind.Relative))
        {
            Content = new StringContent("{ broken", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Connect_with_no_repos_warning_returns_warning_and_does_not_commit()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(
                true, "octocat", null, AuthValidationError.None, null,
                AuthValidationWarning.NoReposSelected)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "github_pat_zero_repos" }),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeTrue();
        body.Warning.Should().Be("no-repos-selected");

        // Token must NOT be committed — auth/state still says hasToken: false.
        var stateResp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        stateResp!.HasToken.Should().BeFalse();
    }

    [Fact]
    public async Task Connect_commit_after_warning_persists_token_and_sets_host()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(
                true, "octocat", null, AuthValidationError.None, null,
                AuthValidationWarning.NoReposSelected)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        // First call: connect returns warning, transient stays pending.
        using var connectReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "github_pat_zero_repos" }),
        };
        connectReq.Headers.Add("Origin", origin);
        var connectResp = await client.SendAsync(connectReq);
        connectResp.IsSuccessStatusCode.Should().BeTrue();

        // Second call: confirm via commit.
        using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
        commitReq.Headers.Add("Origin", origin);
        var commitResp = await client.SendAsync(commitReq);
        commitResp.IsSuccessStatusCode.Should().BeTrue();

        // Token now committed.
        var stateResp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        stateResp!.HasToken.Should().BeTrue();
    }

    [Fact]
    public async Task Connect_commit_returns_409_when_no_transient_pending()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
        commitReq.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(commitReq);

        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.Conflict);
    }

    public sealed record AuthStateResponse(bool HasToken, string Host, HostMismatchInfo? HostMismatch);
    public sealed record HostMismatchInfo(string Old, string New);
    public sealed record ConnectResponse(bool Ok, string? Login, string? Host, string? Error, string? Detail, string? Warning);
}
