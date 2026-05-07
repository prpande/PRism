using System.IO;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class EventsSubscriptionsEndpointTests
{
    [Fact]
    public async Task Subscribe_returns_401_when_no_cookie_session_present()
    {
        // Endpoint's own no-cookie defense (middleware would also 401 if X-PRism-Session
        // were missing). Use an unauthenticated client + manual X-PRism-Session header
        // so middleware passes — the test isolates the endpoint's no-cookie branch.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = new { owner = "o", repo = "r", number = 1 } }),
        };
        req.Headers.Add("X-PRism-Session", factory.SessionToken);
        // No Cookie header — the endpoint must reject with 401.
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Subscribe_returns_403_when_cookie_present_but_no_active_sse_connection()
    {
        // Default client auto-injects the cookie + header but no SSE is opened, so
        // SseChannel returns null for LatestSubscriberIdForCookieSession → 403.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = new { owner = "o", repo = "r", number = 1 } }),
        };
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Subscribe_derives_subscriberId_from_cookie_session_when_sse_active()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        // Open SSE; the auto-injected cookie binds this connection to the test's
        // session inside SseChannel's cookieSessionId multimap.
        using var sseResp = await client.GetAsync(new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead, cts.Token);
        sseResp.StatusCode.Should().Be(HttpStatusCode.OK);
        using var sseStream = await sseResp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(sseStream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token);  // event: subscriber-assigned
        await reader.ReadLineAsync(cts.Token);  // data: { ... }

        // POST with same auto-injected cookie → endpoint resolves subscriberId from
        // the cookie session via SseChannel. SubscriberId is NEVER read from the body.
        var subResp = await client.PostAsJsonAsync(
            new Uri("/api/events/subscriptions", UriKind.Relative),
            new { prRef = new { owner = "o", repo = "r", number = 7 } },
            cts.Token);

        subResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var registry = factory.Services.GetRequiredService<ActivePrSubscriberRegistry>();
        registry.UniquePrRefs().Should().Contain(new PrReference("o", "r", 7));
    }

    [Fact]
    public async Task Subscribe_ignores_subscriberId_field_in_request_body_cross_tab_forge()
    {
        // Threat: a malicious page with the cookie tries to register subscriptions
        // against another tab's connection by injecting a forged subscriberId in the
        // body. The contract record SubscribeRequest only declares PrRef, so the
        // forged field is dropped at deserialization — the endpoint always derives
        // subscriberId from the cookie session.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        using var sseResp = await client.GetAsync(new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead, cts.Token);
        using var sseStream = await sseResp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(sseStream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token);
        await reader.ReadLineAsync(cts.Token);

        var subResp = await client.PostAsJsonAsync(
            new Uri("/api/events/subscriptions", UriKind.Relative),
            new
            {
                prRef = new { owner = "o", repo = "r", number = 9 },
                subscriberId = "forged-by-attacker",
            },
            cts.Token);

        subResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var registry = factory.Services.GetRequiredService<ActivePrSubscriberRegistry>();
        registry.SubscribersFor(new PrReference("o", "r", 9))
            .Should().NotContain("forged-by-attacker");
        registry.SubscribersFor(new PrReference("o", "r", 9))
            .Should().HaveCount(1, "the real, server-issued subscriberId is the only entry");
    }

    [Fact]
    public async Task Unsubscribe_uses_query_string_prRef_and_returns_204()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        using var sseResp = await client.GetAsync(new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead, cts.Token);
        using var sseStream = await sseResp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(sseStream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token);
        await reader.ReadLineAsync(cts.Token);

        await client.PostAsJsonAsync(
            new Uri("/api/events/subscriptions", UriKind.Relative),
            new { prRef = new { owner = "o", repo = "r", number = 12 } },
            cts.Token);

        var unsubResp = await client.DeleteAsync(
            new Uri("/api/events/subscriptions?prRef=o/r/12", UriKind.Relative),
            cts.Token);

        unsubResp.StatusCode.Should().Be(HttpStatusCode.NoContent);
        var registry = factory.Services.GetRequiredService<ActivePrSubscriberRegistry>();
        registry.SubscribersFor(new PrReference("o", "r", 12)).Should().BeEmpty();
    }

    [Fact]
    public async Task Unsubscribe_is_idempotent_when_no_cookie_session()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Delete, "/api/events/subscriptions?prRef=o/r/1");
        req.Headers.Add("X-PRism-Session", factory.SessionToken);
        // No cookie → idempotent 204 (endpoint logic; without the X-PRism-Session
        // header the middleware would have returned 401 before reaching the endpoint).
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }
}
