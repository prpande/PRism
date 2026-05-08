using System.Net;
using System.Net.Http;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Middleware;

public class OriginCheckMiddlewareTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public OriginCheckMiddlewareTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task POST_with_same_origin_is_allowed()
    {
        var client = _factory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().NotBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task POST_with_cross_origin_is_rejected()
    {
        var client = _factory.CreateClient();
        // Drop the factory's default same-origin Origin so the request-level Origin
        // is the only one OriginCheckMiddleware sees.
        client.DefaultRequestHeaders.Remove("Origin");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", "https://evil.example.com");
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task POST_with_empty_Origin_header_is_rejected()
    {
        // S3 PR5: pre-S3 the middleware allowed empty Origin (carve-out for non-
        // browser tools). Retired because spec § 8 mandates X-PRism-Session +
        // present-and-correct Origin together as CSRF defense.
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Remove("Origin");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task GET_with_no_Origin_header_is_allowed()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/health", UriKind.Relative));
        resp.IsSuccessStatusCode.Should().BeTrue();
    }

    [Theory]
    [InlineData("http://localhost:5173")]
    [InlineData("http://127.0.0.1:5173")]
    [InlineData("http://[::1]:5173")]
    public async Task POST_with_loopback_origin_on_different_port_is_allowed(string origin)
    {
        // The Vite dev server runs on :5173 and proxies /api to the backend on :5180.
        // The browser sends Origin=http://localhost:5173, which is loopback but a different
        // port than the backend host. For a localhost-only desktop app this is legitimate
        // same-machine traffic, not a CSRF vector — accept it.
        var client = _factory.CreateClient();
        // Drop the factory's same-origin default so the test's loopback-port value
        // is the only Origin the middleware sees.
        client.DefaultRequestHeaders.Remove("Origin");
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().NotBe(HttpStatusCode.Forbidden);
    }
}
