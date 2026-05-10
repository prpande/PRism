using System.Net;
using System.Net.Http.Headers;
using System.Text;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class RequestSizeLimitTests
{
    // P2.3 — bespoke BodySizeLimitMiddleware was dropped in favor of a pre-routing
    // `app.UseWhen(...)` middleware in Program.cs (the `[RequestSizeLimit(16384)]`
    // attribute path the original plan called for doesn't fire pre-binding for
    // minimal-API endpoints — see plan deferrals sidecar [Superseded] entry for the
    // body-cap implementation shift). The middleware sets MaxRequestBodySize on the
    // feature AND rejects honest oversized clients via a Content-Length pre-check.
    // Spec § 8 + plan Step 5.10b.
    [Theory]
    [InlineData("POST", "/api/events/subscriptions")]
    [InlineData("PUT", "/api/pr/acme/api/123/draft")]
    [InlineData("POST", "/api/pr/acme/api/123/reload")]
    public async Task Mutating_request_with_oversize_body_returns_413(string method, string path)
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-1");

        // 17 KiB JSON body — over the 16 KiB middleware cap. The body shape doesn't have to
        // be valid JSON for the route — the middleware rejects via Content-Length pre-check
        // before the route's body parser runs. Padding key chosen so payload exceeds 16 KiB
        // even after JSON wrapper.
        var oversized = new string('x', 17 * 1024);
        var body = $"{{\"prRef\":{{\"owner\":\"o\",\"repo\":\"r\",\"number\":1}},\"pad\":\"{oversized}\"}}";
        using var content = new StringContent(body, Encoding.UTF8);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

        using var req = new HttpRequestMessage(new HttpMethod(method), path) { Content = content };
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
    }
}
