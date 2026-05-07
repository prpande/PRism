using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests;

public class StaticFilesAndFallbackTests
{
    [Fact]
    public async Task GET_root_serves_SPA_index_html()
    {
        // The SPA fallback (or MapStaticAssets, depending on which has a manifest entry)
        // must serve an HTML response for GET /. We don't assert on the body here because
        // GET / can be served by either the static-asset manifest (real wwwroot index.html
        // when the frontend has been built) or by MapFallbackToFile (the test-factory stub).
        // The body marker check belongs on /inbox-shell, where only MapFallbackToFile can match.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType?.MediaType.Should().Be("text/html");
    }

    [Fact]
    public async Task Client_side_route_falls_back_to_SPA_index_html()
    {
        // /inbox-shell is not in the static-asset manifest and not an API route, so the only
        // path that can serve a 200 text/html response is MapFallbackToFile("index.html").
        // Asserting the stub marker proves the SPA fallback ran and read the file from the
        // overridden web root.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/inbox-shell", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType?.MediaType.Should().Be("text/html");
        var body = await resp.Content.ReadAsStringAsync();
        body.Should().Contain("PRism test stub");
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
