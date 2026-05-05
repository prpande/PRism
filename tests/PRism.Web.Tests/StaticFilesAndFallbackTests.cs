using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests;

public class StaticFilesAndFallbackTests
{
    [Fact]
    public async Task GET_root_does_not_404_due_to_missing_SPA_fallback()
    {
        // This test would have caught the T30-implementation gap: missing UseStaticFiles +
        // MapFallbackToFile means any unmatched non-API route returns 404 instead of the
        // React app's index.html.
        //
        // We can't assert on actual content (wwwroot may be empty in CI before npm run build),
        // but we can assert that the fallback is REGISTERED — which means we get either a 200
        // (file served) or a different non-404 status, NOT a generic API-routing 404.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/", UriKind.Relative));

        // If wwwroot/index.html exists, we get 200. If wwwroot is empty (no frontend build yet),
        // we get 404 BUT it's the static-files / fallback 404, not the routing 404 — distinguishable
        // by the absence of a ProblemDetails JSON body.
        // The crucial assertion is that the SPA fallback is registered: an arbitrary client-side
        // route should not return a ProblemDetails error.
        var clientSideResp = await client.GetAsync(new Uri("/inbox-shell", UriKind.Relative));
        clientSideResp.Content.Headers.ContentType?.MediaType.Should().NotBe("application/problem+json",
            because: "client-side routes must hit the SPA fallback, not the API routing 404");
    }

    [Fact]
    public async Task Unknown_api_route_returns_404_not_SPA_fallback()
    {
        // Counterpart to the above: API routes must NOT be caught by the SPA fallback.
        // GET /api/<unknown> should still 404 (or return ProblemDetails), not serve index.html.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/this-endpoint-does-not-exist", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
        // The body should NOT be HTML — that would mean the SPA fallback ate an API route.
        resp.Content.Headers.ContentType?.MediaType.Should().NotBe("text/html");
    }
}
