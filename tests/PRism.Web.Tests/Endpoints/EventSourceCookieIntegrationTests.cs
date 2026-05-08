using System.Linq;
using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class EventSourceCookieIntegrationTests
{
    [Fact]
    public async Task Index_then_events_uses_cookie_to_authenticate()
    {
        // P2.18 — integration test that the cookie-stamping path actually works for
        // EventSource: load index.html (Program.cs's OnStarting middleware writes
        // Set-Cookie prism-session=…), parse the cookie value out of the response,
        // then open /api/events with that cookie alone (no X-PRism-Session header).
        // SessionTokenMiddleware's cookie path must accept this and return 200, OR
        // the test would fail with 401 — proving the cookie-only authentication
        // round-trip end-to-end.
        //
        // Uses CreateUnauthenticatedClient because CreateClient runs ConfigureClient
        // which auto-injects X-PRism-Session AND a Cookie default — neither of which
        // would actually exercise the cookie-stamping path. ConfigureClient = test
        // would pass for the wrong reason. Server.CreateClient bypasses it.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        var indexResp = await client.GetAsync(new Uri("/", UriKind.Relative));
        indexResp.StatusCode.Should().Be(HttpStatusCode.OK);

        indexResp.Headers.TryGetValues("Set-Cookie", out var setCookies)
            .Should().BeTrue("HTML response must stamp the prism-session cookie");
        var prismCookie = setCookies!.FirstOrDefault(c => c.StartsWith("prism-session=", StringComparison.Ordinal));
        prismCookie.Should().NotBeNull("Set-Cookie must contain prism-session=…");

        // Extract the cookie value (everything between "prism-session=" and the
        // first ";"). Set-Cookie is the response header, NOT the request header
        // form, so the value is URL-encoded — we URL-decode before re-attaching.
        var rawValue = prismCookie!["prism-session=".Length..].Split(';', 2)[0];
        var cookieValue = Uri.UnescapeDataString(rawValue);

        using var sseReq = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        sseReq.Headers.Add("Cookie", $"prism-session={cookieValue}");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var sseResp = await client.SendAsync(sseReq, HttpCompletionOption.ResponseHeadersRead, cts.Token);

        sseResp.StatusCode.Should().Be(HttpStatusCode.OK,
            "the cookie set by the index.html response must authenticate the SSE GET");
        sseResp.Content.Headers.ContentType!.MediaType.Should().Be("text/event-stream");
    }
}
