using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class ParseUrlEndpointTests
{
    private static async Task<HttpResponseMessage> PostParseUrl(
        HttpClient client, string? jsonBody, string? contentType = "application/json")
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/inbox/parse-pr-url", UriKind.Relative));
        if (jsonBody is not null)
            req.Content = new StringContent(jsonBody, Encoding.UTF8, contentType ?? "application/json");
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        return await client.SendAsync(req);
    }

    [Fact]
    public async Task Valid_cloud_url_returns_ok_with_ref()
    {
        // Default config uses github.com
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":"https://github.com/foo/bar/pull/42"}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ok").GetBoolean().Should().BeTrue();
        var r = body.GetProperty("ref");
        r.GetProperty("owner").GetString().Should().Be("foo");
        r.GetProperty("repo").GetString().Should().Be("bar");
        r.GetProperty("number").GetInt32().Should().Be(42);
    }

    [Fact]
    public async Task Valid_ghes_url_returns_ok()
    {
        using var factory = new PRismWebApplicationFactory();
        // DataDir is created by ConfigureWebHost (triggered on first client creation), so ensure
        // it exists before writing config.json.
        Directory.CreateDirectory(factory.DataDir);
        await File.WriteAllTextAsync(
            Path.Combine(factory.DataDir, "config.json"),
            """{"github":{"host":"https://ghe.acme.com"}}""");

        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":"https://ghe.acme.com/myorg/myrepo/pull/7"}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ok").GetBoolean().Should().BeTrue();
        var r = body.GetProperty("ref");
        r.GetProperty("owner").GetString().Should().Be("myorg");
        r.GetProperty("repo").GetString().Should().Be("myrepo");
        r.GetProperty("number").GetInt32().Should().Be(7);
    }

    [Fact]
    public async Task Host_mismatch_returns_structured_error()
    {
        // Config host = github.com; URL is ghe.acme.com → host-mismatch
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":"https://ghe.acme.com/org/repo/pull/1"}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ok").GetBoolean().Should().BeFalse();
        body.GetProperty("error").GetString().Should().Be("host-mismatch");
        body.GetProperty("configuredHost").GetString().Should().Be("https://github.com");
        body.GetProperty("urlHost").GetString().Should().Be("ghe.acme.com");
    }

    [Fact]
    public async Task Malformed_url_returns_malformed_error()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":"not a url"}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ok").GetBoolean().Should().BeFalse();
        body.GetProperty("error").GetString().Should().Be("malformed");
    }

    [Fact]
    public async Task Post_parse_url_with_http_url_against_https_host_returns_host_mismatch()
    {
        // Config host = https://github.com (default); URL is http://github.com/... (scheme-only mismatch).
        // Even though u.Host == h.Host, the scheme differs, so for the user the "host" (origin) is
        // different. Reuse the host-mismatch error code rather than falling back to not-a-pr-url.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":"http://github.com/owner/repo/pull/1"}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ok").GetBoolean().Should().BeFalse();
        body.GetProperty("error").GetString().Should().Be("host-mismatch");
    }

    [Fact]
    public async Task Non_pr_url_returns_not_a_pr_url_error()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":"https://github.com/foo/bar/issues/1"}""");

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("ok").GetBoolean().Should().BeFalse();
        body.GetProperty("error").GetString().Should().Be("not-a-pr-url");
    }

    [Fact]
    public async Task Empty_url_returns_400_url_required()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{"url":""}""");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("error").GetString().Should().Be("url-required");
    }

    [Fact]
    public async Task Missing_url_field_returns_400_url_required()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, """{}""");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("error").GetString().Should().Be("url-required");
    }

    [Fact]
    public async Task Invalid_json_returns_400_invalid_json()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(client, "not json");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("error").GetString().Should().Be("invalid-json");
    }

    [Fact]
    public async Task Post_parse_url_without_content_type_returns_400_invalid_json()
    {
        // ReadFromJsonAsync throws InvalidOperationException (not JsonException) when the
        // request lacks a JSON Content-Type. Without a HasJsonContentType() pre-check, the
        // endpoint would 500 instead of returning a structured 400 invalid-json — same
        // failure shape callers see for malformed bodies.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await PostParseUrl(
            client,
            """{"url":"https://github.com/foo/bar/pull/42"}""",
            contentType: "text/plain");

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("error").GetString().Should().Be("invalid-json");
    }
}
