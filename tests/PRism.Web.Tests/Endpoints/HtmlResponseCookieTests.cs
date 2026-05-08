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
}
