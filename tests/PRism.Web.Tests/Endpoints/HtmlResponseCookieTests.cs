using System.Net;
using System.Linq;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class HtmlResponseCookieTests
{
    [Fact]
    public async Task Root_GET_serves_html_with_Set_Cookie_prism_session()
    {
        // Spec § 8: every text/html response carries a fresh `prism-session` cookie
        // stamped via Response.OnStarting (so it lands before the body byte stream).
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("text/html");

        resp.Headers.TryGetValues("Set-Cookie", out var cookies).Should().BeTrue("HTML response must stamp prism-session");
        var prismCookie = cookies!.FirstOrDefault(c => c.StartsWith("prism-session=", StringComparison.Ordinal));
        prismCookie.Should().NotBeNull();
        // The cookie writer URL-encodes the value (`+`/`/`/`=` from Base64 are escaped),
        // so compare against the encoded form rather than the raw token.
        prismCookie.Should().Contain($"prism-session={Uri.EscapeDataString(factory.SessionToken)}");
        prismCookie.Should().Contain("path=/", "spec § 8 requires explicit Path=/");
        prismCookie.Should().Contain("samesite=strict", "spec § 8 requires SameSite=Strict");
    }

    [Fact]
    public async Task Root_GET_html_carries_Cache_Control_no_store()
    {
        // #433: the per-process prism-session cookie is stamped only on 200 text/html.
        // Electron's persistent HTTP cache can serve a 304 / from-cache index.html that
        // omits a fresh Set-Cookie, stranding the previous launch's stale cookie → a
        // cold-start 401. Binding Cache-Control: no-store to the SAME text/html branch
        // forces a full 200 re-fetch (and cookie re-stamp) every launch. We assert the
        // FINAL header value sent, which also pins the overwrite-wins behavior against any
        // Cache-Control a static-file handler set earlier in the pipeline.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        var resp = await client.GetAsync(new Uri("/", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("text/html");
        resp.Headers.CacheControl.Should().NotBeNull(
            "a response carrying the per-process session cookie must never be cached (#433)");
        resp.Headers.CacheControl!.NoStore.Should().BeTrue(
            "no-store forces Electron to re-fetch index.html and re-stamp the session cookie each launch");
    }

    [Fact]
    public async Task Json_api_200_does_not_get_no_store_from_html_branch()
    {
        // The no-store directive rides the text/html predicate, exactly like the cookie.
        // A JSON API 200 carries neither — assert the negative so the predicate doesn't
        // leak no-store onto cacheable API responses.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/auth/state", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().NotBe("text/html");
        (resp.Headers.CacheControl?.NoStore ?? false).Should().BeFalse(
            "no-store is bound to the text/html cookie branch, not JSON API responses");
    }
}
