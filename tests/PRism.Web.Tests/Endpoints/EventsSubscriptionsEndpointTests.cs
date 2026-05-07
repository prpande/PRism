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
    private const string Cookie = "prism-session=test-token-1; Path=/";

    [Fact]
    public async Task Subscribe_returns_401_when_no_cookie_session_present()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = new { owner = "o", repo = "r", number = 1 } }),
        };
        // No Cookie header — Subscribe must reject with 401.
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Subscribe_returns_403_when_cookie_present_but_no_active_sse_connection()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = new { owner = "o", repo = "r", number = 1 } }),
        };
        req.Headers.Add("Cookie", Cookie);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Subscribe_derives_subscriberId_from_cookie_session_when_sse_active()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        // Open SSE with the cookie attached so SseChannel maps cookie → subscriberId.
        using var sseReq = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        sseReq.Headers.Add("Cookie", Cookie);
        using var sseResp = await client.SendAsync(sseReq, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        sseResp.StatusCode.Should().Be(HttpStatusCode.OK);

        // Drain the subscriber-assigned event so we know the connection is registered.
        using var sseStream = await sseResp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(sseStream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token);  // event: subscriber-assigned
        await reader.ReadLineAsync(cts.Token);  // data: { ... }

        // Now POST /subscriptions with the same cookie — endpoint resolves subscriberId
        // from the cookie session via SseChannel, never from the request body.
        using var subReq = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = new { owner = "o", repo = "r", number = 7 } }),
        };
        subReq.Headers.Add("Cookie", Cookie);
        var subResp = await client.SendAsync(subReq, cts.Token);

        subResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Verify the registry actually got the subscription.
        var registry = factory.Services.GetRequiredService<ActivePrSubscriberRegistry>();
        registry.UniquePrRefs().Should().Contain(new PrReference("o", "r", 7));
    }

    [Fact]
    public async Task Subscribe_ignores_subscriberId_field_in_request_body_cross_tab_forge()
    {
        // Threat: a malicious page that somehow holds the cookie tries to forge a
        // subscriberId in the body to register subscriptions against another tab's
        // SSE connection. Endpoint must derive subscriberId from cookie session ONLY
        // (any subscriberId field in the body is ignored — the body shape doesn't
        // even include one).
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        using var sseReq = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        sseReq.Headers.Add("Cookie", Cookie);
        using var sseResp = await client.SendAsync(sseReq, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        using var sseStream = await sseResp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(sseStream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token);
        await reader.ReadLineAsync(cts.Token);

        // Body includes a `subscriberId` field — the endpoint must IGNORE it (the contract
        // record SubscribeRequest defines only PrRef; extra fields are dropped by binder).
        using var subReq = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new
            {
                prRef = new { owner = "o", repo = "r", number = 9 },
                subscriberId = "forged-by-attacker",
            }),
        };
        subReq.Headers.Add("Cookie", Cookie);
        var subResp = await client.SendAsync(subReq, cts.Token);

        subResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // The forged subscriberId did not register anywhere. The real subscriberId
        // (server-issued) is what the registry holds.
        var registry = factory.Services.GetRequiredService<ActivePrSubscriberRegistry>();
        registry.SubscribersFor(new PrReference("o", "r", 9)).Should().NotContain("forged-by-attacker");
        registry.SubscribersFor(new PrReference("o", "r", 9)).Should().HaveCount(1);
    }

    [Fact]
    public async Task Unsubscribe_uses_query_string_prRef_and_returns_204()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        using var sseReq = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        sseReq.Headers.Add("Cookie", Cookie);
        using var sseResp = await client.SendAsync(sseReq, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        using var sseStream = await sseResp.Content.ReadAsStreamAsync(cts.Token);
        using var reader = new StreamReader(sseStream, Encoding.UTF8);
        await reader.ReadLineAsync(cts.Token);
        await reader.ReadLineAsync(cts.Token);

        using var subReq = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = new { owner = "o", repo = "r", number = 12 } }),
        };
        subReq.Headers.Add("Cookie", Cookie);
        (await client.SendAsync(subReq, cts.Token)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var unsubReq = new HttpRequestMessage(HttpMethod.Delete, "/api/events/subscriptions?prRef=o/r/12");
        unsubReq.Headers.Add("Cookie", Cookie);
        var unsubResp = await client.SendAsync(unsubReq, cts.Token);

        unsubResp.StatusCode.Should().Be(HttpStatusCode.NoContent);
        var registry = factory.Services.GetRequiredService<ActivePrSubscriberRegistry>();
        registry.SubscribersFor(new PrReference("o", "r", 12)).Should().BeEmpty();
    }

    [Fact]
    public async Task Unsubscribe_is_idempotent_when_no_cookie_session()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        using var req = new HttpRequestMessage(HttpMethod.Delete, "/api/events/subscriptions?prRef=o/r/1");
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }
}
