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
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", "https://evil.example.com");
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
}
