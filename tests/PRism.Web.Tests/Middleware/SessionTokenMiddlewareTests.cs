using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using PRism.Web.Middleware;
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
    public async Task Bypasses_enforcement_when_env_is_development()
    {
        // SessionTokenMiddleware is bypassed in Development because the Vite dev
        // server serves the SPA's HTML (cookie-stamping middleware doesn't run
        // against that response → browser has no cookie for the 5173 origin → and
        // same-origin GET fetches don't always send Origin so the loopback-port
        // branch can't fire reliably either). Test + Production environments still
        // enforce. Since tests can't easily mutate the running ASP.NET host
        // environment, this test asserts via construction: a fresh middleware
        // instance built with Environment=Development passes a request through
        // without checking the token.
        var calledNext = false;
        RequestDelegate next = (_) => { calledNext = true; return Task.CompletedTask; };
        var env = new TestHostEnvironment("Development");
        var provider = new SessionTokenProvider(env);
        var mw = new SessionTokenMiddleware(next, provider, env);

        var ctx = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        ctx.Request.Path = "/api/capabilities";

        await mw.InvokeAsync(ctx);

        calledNext.Should().BeTrue("Development env must bypass auth so Vite-proxied SPA traffic flows");
        ctx.Response.StatusCode.Should().NotBe(401);
    }

    private sealed class TestHostEnvironment : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public TestHostEnvironment(string envName) { EnvironmentName = envName; }
        public string EnvironmentName { get; set; }
        public string ApplicationName { get; set; } = "PRism.Web.Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    [Fact]
    public async Task Skips_auth_for_loopback_different_port_origin()
    {
        // Vite dev server at :5173 proxies /api to backend at :5180. Vite serves
        // the SPA's HTML, so cookie stamping never runs against the page → the
        // browser never has a prism-session cookie for the 5173 origin. The
        // middleware mirrors OriginCheckMiddleware's existing accommodation:
        // both sides loopback (different ports) = legitimate dev traffic. Spec
        // § 8 (post-PR5 edit). Production deploys (Host not loopback) hit the
        // strict cookie-OR-header path.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/capabilities");
        req.Headers.Add("Origin", "http://localhost:5173");
        // No X-PRism-Session header, no prism-session cookie — only the loopback
        // Origin proves "this is dev traffic from a sibling localhost port."
        var resp = await client.SendAsync(req);

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
