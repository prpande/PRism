using System.Net.Http;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

using PRism.Web.Middleware;

namespace PRism.Web.Tests.TestHelpers;

// Shared seam for the per-process session credentials every authenticated test client needs.
// Two receivers, one definition of the header set:
//   - PRismWebApplicationFactory.ConfigureClient auto-injects them on the base factory's client.
//   - The WithWebHostBuilder-derived per-test context harnesses (SubmitEndpointsTestContext,
//     CommentTestContext, RootCommentTestContext, DiscardTestContext, DiscardAllUnsubscribedContext)
//     can't inherit that override (WithWebHostBuilder returns a plain WebApplicationFactory<Program>),
//     so they build their client via CreateAuthenticatedClient instead. Keeping the header set in one
//     place stops the two paths from drifting.
internal static class TestClientExtensions
{
    // Adds the session token (header + cookie) and a same-origin Origin header the
    // post-S3 OriginCheckMiddleware requires on mutating verbs. Origin is skipped when
    // the client has no BaseAddress yet (mirrors ConfigureClient's guard).
    public static void AddPrismSessionHeaders(this HttpClient client, string token)
    {
        ArgumentNullException.ThrowIfNull(client);
        client.DefaultRequestHeaders.Add("X-PRism-Session", token);
        client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin))
            client.DefaultRequestHeaders.Add("Origin", origin);
    }

    // Builds a client off a WithWebHostBuilder-derived factory carrying the same auto-injected
    // credentials PRismWebApplicationFactory.ConfigureClient would have added, plus an optional
    // X-PRism-Tab-Id. tabId defaults to null (no header); callers that rely on the submit-gate's
    // per-tab stamp pass "tab-test" explicitly via their own CreateClient default.
    public static HttpClient CreateAuthenticatedClient(
        this WebApplicationFactory<Program> factory, string? tabId = null)
    {
        ArgumentNullException.ThrowIfNull(factory);
        var token = factory.Services.GetRequiredService<SessionTokenProvider>().Current;
        var client = factory.CreateClient();
        client.AddPrismSessionHeaders(token);
        if (!string.IsNullOrEmpty(tabId))
            client.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return client;
    }
}
