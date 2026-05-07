using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class EventSourceCookieIntegrationTests
{
    [Fact]
    public async Task Index_then_events_uses_cookie_to_authenticate()
    {
        // P2.18 — integration test that the cookie stamping path actually works for
        // EventSource: load index.html (which sets the cookie via response Set-Cookie),
        // then open /api/events from the same client (cookies preserved by handler).
        // Without the cookie path through SessionTokenMiddleware, this would 401.
        using var factory = new PRismWebApplicationFactory();
        var options = new WebApplicationFactoryClientOptions { HandleCookies = true };
        using var client = factory.CreateClientWithOptions(options);

        // Load the SPA index to stamp the cookie. The factory's default handler stores
        // Set-Cookie automatically when HandleCookies is true.
        var indexResp = await client.GetAsync(new Uri("/", UriKind.Relative));
        indexResp.StatusCode.Should().Be(HttpStatusCode.OK);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var sseResp = await client.GetAsync(new Uri("/api/events", UriKind.Relative),
            HttpCompletionOption.ResponseHeadersRead, cts.Token);

        sseResp.StatusCode.Should().Be(HttpStatusCode.OK,
            "the cookie set by the index.html response must authenticate the SSE GET");
        sseResp.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
    }
}

internal static class FactoryClientHelpers
{
    // Bypasses ConfigureClient (which adds default auth headers) so cookie-handling
    // tests start with a fresh handler that only carries Set-Cookie state.
    public static HttpClient CreateClientWithOptions(this PRismWebApplicationFactory factory,
        WebApplicationFactoryClientOptions options)
    {
        ArgumentNullException.ThrowIfNull(factory);
        ArgumentNullException.ThrowIfNull(options);
        return factory.CreateDefaultClient(
            new Uri(options.BaseAddress.ToString()),
            (DelegatingHandler[])Array.Empty<DelegatingHandler>());
    }
}
