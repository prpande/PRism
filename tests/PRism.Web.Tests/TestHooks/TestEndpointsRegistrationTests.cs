using System.IO;
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.TestHooks;

// Negative-side of the env-guard contract. The positive side (Playwright actually
// being able to hit /test/advance-head under Test env) is exercised by the
// frontend E2E suite; this xUnit test only guards against the failure mode the
// plan calls out: /test/* leaking into Production.
public class TestEndpointsRegistrationTests
{
    [Theory]
    [InlineData("/test/advance-head")]
    [InlineData("/test/set-draft")]
    public async Task TestEndpoints_NotLiveInProduction(string route)
    {
        // Boot the host with ASPNETCORE_ENVIRONMENT=Production. MapTestEndpoints
        // must short-circuit at registration and leave both routes unmapped.
        // The actual response status depends on what catches the request:
        //   - 404 if no fallback file is present in the test wwwroot
        //   - 405 if the SPA fallback is GET-only and rejects POST
        //   - 200 with text/html if the SPA fallback served index.html
        // All three are acceptable — the load-bearing invariant is "/test/*
        // is NOT a live JSON endpoint in Production". The test name reflects
        // that contract rather than the more specific "404" the earlier
        // revision claimed.
        //
        // Production is also the ONLY environment that takes the non-Test branch of
        // Program.cs, so this is the only suite that reaches the lockfile block
        // (Program.cs:236). Point DataDir at an isolated temp directory so that block
        // acquires its lockfile there instead of the developer's real data dir — which
        // otherwise fails the moment a real PRism instance is running, and mutates the
        // user's live state.json.lock. Mirrors PRismWebApplicationFactory's isolation. (#750)
        var dataDir = TempDataDir.NewPath("PRism-test-endpoints");
        Directory.CreateDirectory(dataDir);
        try
        {
            await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            {
                b.UseEnvironment("Production");
                b.UseSetting("DataDir", dataDir);
            });
            var client = factory.CreateClient();
            // Set Origin so OriginCheckMiddleware (which rejects mutating verbs
            // without it) does not 403 the request before routing happens.
            // Without this header, the request fails for the wrong reason — a 403
            // from CSRF defense — and the test would falsely pass even if
            // MapTestEndpoints had regressed and registered the route in Production.
            var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
            if (!string.IsNullOrEmpty(origin)) client.DefaultRequestHeaders.Add("Origin", origin);

            var resp = await client.PostAsJsonAsync(route, new { });

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
                    $"{route} must not be live-routed in Production — got JSON response");
            }
            else
            {
                ((int)resp.StatusCode).Should().BeInRange(400, 499,
                    $"Production must reject {route} with a client error, not register the route");
            }
        }
        finally
        {
            try { if (Directory.Exists(dataDir)) Directory.Delete(dataDir, recursive: true); }
#pragma warning disable CA1031 // best-effort cleanup of an isolated temp dir
            catch { }
#pragma warning restore CA1031
        }
    }
}
