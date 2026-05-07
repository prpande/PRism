using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class EventSourcePingTests
{
    [Fact]
    public async Task Ping_returns_200_OK()
    {
        // P1.5 — sentinel for the EventSource silent-401 detection on the frontend.
        // The 401 path is exercised in SessionTokenMiddlewareTests once the middleware
        // is wired (PR5 commit 2). For commit 1, this test confirms the route exists
        // and returns 200 when authenticated (or unauthenticated, before middleware).
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/events/ping", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
