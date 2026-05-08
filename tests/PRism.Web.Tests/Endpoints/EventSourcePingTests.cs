using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class EventSourcePingTests
{
    [Fact]
    public async Task Ping_returns_200_when_authenticated()
    {
        // P1.5 — sentinel for the EventSource silent-401 detection on the frontend.
        // The frontend uses ping to escalate from EventSource onerror to a force-reload.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/events/ping", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Ping_returns_401_when_session_token_invalid()
    {
        // The 401 path is the whole point of /ping — frontend probes it after an
        // EventSource onerror; if it 401s, the SPA force-reloads to refresh the
        // stale cookie.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/events/ping");
        req.Headers.Add("X-PRism-Session", "wrong-token");
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
