using System.Net;
using System.Net.Http.Headers;
using PRism.Core.Inbox; // RateLimitExceededException
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubHttpTests
{
    // Captures the outgoing request so assertions can inspect headers/URI.
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        public HttpResponseMessage Response = new(HttpStatusCode.OK);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            return Task.FromResult(Response);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) Response.Dispose();
            base.Dispose(disposing);
        }
    }

    private static HttpClient Client(CapturingHandler h, string baseAddress = "https://api.github.com/")
        => new(h) { BaseAddress = new Uri(baseAddress) };

    [Fact]
    public async Task SendAsync_attaches_standard_headers_and_version()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, "user", "tok", CancellationToken.None);

        var req = h.Last!;
        Assert.Equal("PRism/0.1", req.Headers.UserAgent.ToString());
        Assert.Contains("application/vnd.github+json", req.Headers.Accept.ToString(), StringComparison.Ordinal);
        Assert.True(req.Headers.TryGetValues("X-GitHub-Api-Version", out var v) && v.Single() == "2022-11-28");
        Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
        Assert.Equal("tok", req.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task SendAsync_empty_token_sends_no_authorization()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get, "user", token: null, CancellationToken.None);
        Assert.Null(h.Last!.Headers.Authorization);
    }

    [Fact]
    public async Task SendAsync_accept_override_replaces_default()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get, "x", "tok", CancellationToken.None,
            accept: "application/vnd.github.raw");
        Assert.Equal("application/vnd.github.raw", h.Last!.Headers.Accept.ToString());
    }

    [Fact]
    public async Task SendAsync_apiVersion_false_sends_no_version_header()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Post, "graphql", "tok", CancellationToken.None,
            apiVersion: false);
        Assert.False(h.Last!.Headers.Contains("X-GitHub-Api-Version"));
    }

    [Fact]
    public async Task SendAsync_same_host_absolute_url_attaches_token()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get,
            "https://api.github.com/repositories/1/pulls?page=2", "tok", CancellationToken.None);
        Assert.Equal("tok", h.Last!.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task SendAsync_off_host_absolute_url_with_token_throws()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "https://evil.example.com/steal", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_graphql_endpoint_passes_host_guard_on_ghes()
    {
        var h = new CapturingHandler();
        using var http = Client(h, "https://ghe.corp.example/api/v3/");
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Post,
            "https://ghe.corp.example/api/graphql", "tok", CancellationToken.None, apiVersion: false);
        Assert.Equal("tok", h.Last!.Headers.Authorization!.Parameter);
    }

    [Fact]
    public void ThrowIfRateLimited_throws_on_429_with_retry_after()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        resp.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(30));
        var ex = Assert.Throws<RateLimitExceededException>(() => GitHubHttp.ThrowIfRateLimited(resp));
        Assert.Equal(TimeSpan.FromSeconds(30), ex.RetryAfter);
    }

    [Fact]
    public void ThrowIfRateLimited_subject_preserves_search_message()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        var ex = Assert.Throws<RateLimitExceededException>(
            () => GitHubHttp.ThrowIfRateLimited(resp, " Search API"));
        Assert.Contains("Search API", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ThrowIfRateLimited_noop_on_success()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.OK);
        GitHubHttp.ThrowIfRateLimited(resp); // must not throw
    }

    [Fact]
    public async Task ReadErrorBodyBestEffortAsync_returns_body()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.BadRequest)
        { Content = new StringContent("boom") };
        Assert.Equal("boom", await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_off_host_with_null_base_address_throws()
    {
        var h = new CapturingHandler();
        using var http = new HttpClient(h); // no BaseAddress
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "https://api.github.com/x", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_same_host_different_port_with_token_throws()
    {
        var h = new CapturingHandler();
        using var http = Client(h); // BaseAddress https://api.github.com/ (port 443)
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "https://api.github.com:8080/x", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_http_downgrade_same_host_port_with_token_throws()
    {
        // Explicit http://host:443 matches host+port but is plaintext — the scheme check
        // must refuse the PAT (Copilot review, PR #372).
        var h = new CapturingHandler();
        using var http = Client(h); // https://api.github.com/ (https, port 443)
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "http://api.github.com:443/x", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_passes_absolute_ghes_url_through_without_doubling_prefix()
    {
        // Proves the §4.2 GHES fix: passing the absolute Link URL avoids the /api/v3/api/v3/
        // doubling that re-resolving a relative path against BaseAddress would cause.
        var h = new CapturingHandler();
        using var http = Client(h, "https://ghe.corp.example/api/v3/");
        const string abs = "https://ghe.corp.example/api/v3/repos/o/r/pulls/1/files?page=2";
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get, abs, "tok", CancellationToken.None);
        Assert.Equal(abs, h.Last!.RequestUri!.ToString());
    }
}
