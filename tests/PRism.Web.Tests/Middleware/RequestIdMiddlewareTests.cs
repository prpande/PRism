using System.Net.Http;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Middleware;

public class RequestIdMiddlewareTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public RequestIdMiddlewareTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Every_response_carries_X_Request_Id()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/health", UriKind.Relative));
        resp.Headers.Contains("X-Request-Id").Should().BeTrue();
        resp.Headers.GetValues("X-Request-Id").First().Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task Inbound_X_Request_Id_is_echoed()
    {
        var client = _factory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Get, new Uri("/api/health", UriKind.Relative));
        req.Headers.Add("X-Request-Id", "test-123");
        var resp = await client.SendAsync(req);
        resp.Headers.GetValues("X-Request-Id").Single().Should().Be("test-123");
    }
}
