using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace PRism.Web.Tests.TestHooks;

// Negative-side of the env-guard contract. The positive side (Playwright actually
// being able to hit /test/advance-head under Test env) is exercised by the
// frontend E2E suite; this xUnit test only guards against the failure mode the
// plan calls out: /test/* leaking into Production.
public class TestEndpointsRegistrationTests
{
    [Fact]
    public async Task TestEndpoints_NotRegisteredInProduction_404()
    {
        // Boot the host with ASPNETCORE_ENVIRONMENT=Production. MapTestEndpoints
        // must short-circuit at registration and leave both routes unmapped, so
        // the SPA fallback hits and returns 404 (MapFallback at "/api/{*rest}"
        // only catches /api/* — /test/* falls through to the index.html fallback,
        // which returns 200 with HTML. We assert the JSON 404 from a HEAD-equivalent
        // probe: POST /test/advance-head should NOT succeed.)
        await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Production");
        });
        var client = factory.CreateClient();

        var resp = await client.PostAsJsonAsync(
            "/test/advance-head",
            new { newHeadSha = "4444444444444444444444444444444444444444", fileChanges = Array.Empty<object>() });

        // SPA fallback would happily serve index.html for non-/api/* unknown
        // routes. We accept either:
        //  - 404 (no fallback file present in test wwwroot)
        //  - 405 Method Not Allowed (the fallback is GET-only; POST returns 405)
        //  - 200 with text/html content (fallback served HTML — assert NOT JSON
        //    indicating the test endpoint actually fired)
        // The critical assertion: the response is NOT { "ok": true } JSON, which
        // would mean the endpoint registered and accepted the mutation.
        if (resp.StatusCode == HttpStatusCode.OK)
        {
            var contentType = resp.Content.Headers.ContentType?.MediaType;
            contentType.Should().NotBe("application/json",
                "/test/advance-head must not be live-routed in Production — got JSON response");
        }
        else
        {
            ((int)resp.StatusCode).Should().BeInRange(400, 499,
                "Production must reject /test/* with a client error, not register the route");
        }
    }
}
