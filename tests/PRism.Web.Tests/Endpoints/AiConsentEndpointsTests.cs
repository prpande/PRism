using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Ai;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

/// <summary>
/// Integration tests for GET /api/ai/egress-disclosure and POST /api/ai/consent (spec §5).
///
/// Cases:
/// A — GET returns 200 with disclosure payload and alreadyConsented=false (no prior consent).
/// B — POST { disclosureVersion:"1" } returns 204; subsequent GET shows alreadyConsented=true.
/// C — POST { disclosureVersion:"0" } returns 409 (stale version).
/// D — GET/POST without a session token → 401 (SessionTokenMiddleware).
/// E — POST without an Origin header → 403 (OriginCheckMiddleware).
/// </summary>
public sealed class AiConsentEndpointsTests
{
    // --- Case A ---
    [Fact]
    public async Task A_Get_egress_disclosure_returns_200_with_payload_and_alreadyConsented_false()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/ai/egress-disclosure", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;

        root.GetProperty("recipient").GetString().Should().NotBeNullOrWhiteSpace();
        var cats = root.GetProperty("dataCategories");
        cats.GetArrayLength().Should().Be(3);
        root.GetProperty("disclosureVersion").GetString().Should().Be("1");
        root.GetProperty("alreadyConsented").GetBoolean().Should().BeFalse();
    }

    // --- Case B ---
    [Fact]
    public async Task B_Post_consent_with_current_version_returns_204_then_GET_shows_alreadyConsented_true()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        // POST to record consent
        var postResp = await client.PostAsJsonAsync(
            new Uri("/api/ai/consent", UriKind.Relative),
            new { disclosureVersion = "1" });
        postResp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // GET should now reflect consented state
        var getResp = await client.GetAsync(new Uri("/api/ai/egress-disclosure", UriKind.Relative));
        getResp.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await getResp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(raw);
        doc.RootElement.GetProperty("alreadyConsented").GetBoolean().Should().BeTrue();
    }

    // --- Case C ---
    [Fact]
    public async Task C_Post_consent_with_stale_version_returns_409()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/ai/consent", UriKind.Relative),
            new { disclosureVersion = "0" });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    // --- Case D ---
    [Fact]
    public async Task D_Get_egress_disclosure_without_session_returns_401()
    {
        using var factory = new PRismWebApplicationFactory();
        // CreateUnauthenticatedClient bypasses ConfigureClient (which auto-injects the
        // session token + Origin header) — SessionTokenMiddleware fires before any endpoint
        // logic and returns 401.
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/ai/egress-disclosure", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task D_Post_consent_without_session_returns_401()
    {
        using var factory = new PRismWebApplicationFactory();
        // Session token absent; Origin is present so OriginCheckMiddleware passes but
        // SessionTokenMiddleware rejects first.
        var client = factory.CreateUnauthenticatedClient();
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin))
            client.DefaultRequestHeaders.Add("Origin", origin);

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/ai/consent", UriKind.Relative),
            new { disclosureVersion = "1" });

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // --- Case E ---
    [Fact]
    public async Task E_Post_consent_without_Origin_returns_403()
    {
        using var factory = new PRismWebApplicationFactory();
        // CreateClient auto-injects Origin; remove it to exercise OriginCheckMiddleware.
        // Session token is still present so the 403 comes from the origin check, not 401.
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Remove("Origin");

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/ai/consent", UriKind.Relative),
            new { disclosureVersion = "1" });

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
