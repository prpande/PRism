using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Middleware;

public class SessionTokenMiddlewareTests
{
    [Fact]
    public async Task Allows_request_when_X_PRism_Session_header_matches()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        req.Headers.Add("X-PRism-Session", factory.SessionToken);
        var resp = await client.SendAsync(req);

        resp.IsSuccessStatusCode.Should().BeTrue();
    }

    [Fact]
    public async Task Returns_401_when_X_PRism_Session_header_missing()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Returns_401_when_X_PRism_Session_header_wrong_same_length()
    {
        // P2.4: same-length-wrong-bytes path — fixed-length comparison via
        // CryptographicOperations.FixedTimeEquals. Behavioral assertion (both 401);
        // timing is the contract of the BCL primitive, not a thing this test can
        // reliably observe through the full HTTP stack.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        var realToken = factory.SessionToken;
        var sameLenWrongToken = new string('A', realToken.Length);

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        req.Headers.Add("X-PRism-Session", sameLenWrongToken);
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Returns_401_when_X_PRism_Session_header_too_short()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        req.Headers.Add("X-PRism-Session", "short");
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Returns_problem_details_with_session_stale_type_on_401()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        var pd = await resp.Content.ReadFromJsonAsync<ProblemDetailsShape>();
        pd!.Type.Should().Be("/auth/session-stale");
        pd.Title.Should().Be("Session token mismatch");
    }

    [Fact]
    public async Task Skips_non_api_paths_without_token()
    {
        // Asset / SPA HTML / other non-/api paths must work without the token, since
        // the SPA's HTML index is what stamps the cookie in the first place.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Skips_api_health_liveness_probe_without_token()
    {
        // /api/health is a liveness endpoint by convention. The Playwright no-browser
        // e2e test (request.newContext) hits it without a browser cookie. Auth-gating
        // a liveness probe breaks that contract and exposes nothing sensitive — health
        // bodies carry only port + version.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/api/health", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Allows_request_when_only_prism_session_cookie_is_set()
    {
        // The SPA's existing apiClient does not echo X-PRism-Session as a header — same-
        // origin fetch carries the cookie automatically, and that's enough proof. Spec
        // § 8 + the deferrals sidecar entry record the cookie-OR-header acceptance.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        req.Headers.Add("Cookie", $"prism-session={factory.SessionToken}");
        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Sse_endpoint_uses_cookie_path_not_header()
    {
        // EventSource cannot send custom headers, so /api/events authenticates via
        // the prism-session cookie. Token in cookie → 200 OK; no token → 401.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var withCookie = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        withCookie.Headers.Add("Cookie", $"prism-session={factory.SessionToken}");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var ok = await client.SendAsync(withCookie, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
        ok.Dispose();

        using var withoutCookie = new HttpRequestMessage(HttpMethod.Get, "/api/events");
        using var cts2 = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var blocked = await client.SendAsync(withoutCookie, HttpCompletionOption.ResponseHeadersRead, cts2.Token);
        blocked.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes",
        Justification = "Deserialized from JSON via reflection in ReadFromJsonAsync.")]
    private sealed class ProblemDetailsShape
    {
        public string? Type { get; set; }
        public string? Title { get; set; }
    }
}
