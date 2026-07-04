using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

using FluentAssertions;

using PRism.Core;
using PRism.Core.Events;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

// Task 5 (#571) — POST /api/pr/{owner}/{repo}/{number:int:min(1)}/thread/{resolve|unresolve}
//
// Gate order mirrors PrLifecycleEndpoints.HandleAsync exactly, with a new gate 3 (thread<->PR
// membership binding, spec §5.4) inserted between the body-parse gate and the write:
//   1. Subscribe gate (RequireSubscribed.Check)          -> 403 { code: "unauthorized" }
//   2. CSRF tab-id gate (TabStamps.TryValidateTabId)     -> 422 { code: "tab-id-missing" }
//   3. Body / threadId-required gate                    -> 400 { code: "thread-id-required" }
//   4. Thread<->PR membership gate (NEW)                 -> 404 { code: "thread-not-found" }
//   5. Write + error mapping / success publish
//
// Gate ORDER is asserted implicitly: Not_subscribed_returns_403_unauthorized posts a body with
// no threadId at all under an unsubscribed cache and still gets the subscribe 403, proving gate 1
// runs before gates 2-4 would otherwise reject it differently.
public class PrReviewThreadEndpointsTests
{
    private static HttpRequestMessage Post(string action, string body) =>
        new(HttpMethod.Post, $"/api/pr/o/r/1/thread/{action}")
        {
            Headers = { { "X-PRism-Tab-Id", "tab-123" } },
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

    private static string KnownBody =>
        $"{{\"threadId\":\"{PrReviewThreadEndpointsTestContext.KnownThreadId}\"}}";

    [Fact]
    public async Task Not_subscribed_returns_403_unauthorized()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        ctx.SetSubscribed(false);
        using var client = ctx.CreateClient();

        // Body omits threadId entirely — proves the subscribe gate rejects BEFORE the body is
        // even parsed (gate order: subscribe -> tab-id -> body -> membership -> write).
        var resp = await client.SendAsync(Post("resolve", "{}"));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("unauthorized");
        ctx.Writer.Calls.Should().BeEmpty();
    }

    // claude[bot] review (PR #726): pins the non-disclosure invariant that the subscribe-before-
    // membership gate ordering exists to protect. An UNSUBSCRIBED caller posting a WELL-FORMED but
    // FOREIGN threadId must get the subscribe 403 — NOT the membership 404. If the order ever
    // flipped, 404-vs-403 would let an unsubscribed caller probe which threads exist on a PR they
    // cannot see. Distinct from Foreign_threadId_returns_404 (that caller IS subscribed) and from
    // Not_subscribed (that body has no threadId, so it never reaches the membership gate anyway).
    [Fact]
    public async Task Not_subscribed_with_foreign_threadId_returns_403_unauthorized_not_404()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        ctx.SetSubscribed(false);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("resolve", "{\"threadId\":\"PRRT_foreign\"}"));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("unauthorized");
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Fact]
    public async Task Missing_tab_id_returns_422_tab_id_missing()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        // Plain client() default-injects X-PRism-Tab-Id: "tab-test"; pass tabId: null to
        // genuinely omit the header (mirrors PrLifecycleEndpointsTests.Missing_tab_id_header_is_rejected).
        using var client = ctx.CreateClient(tabId: null);
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/pr/o/r/1/thread/resolve")
        {
            Content = new StringContent(KnownBody, Encoding.UTF8, "application/json"),
        };

        var resp = await client.SendAsync(req);

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("tab-id-missing");
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Fact]
    public async Task Missing_threadId_returns_400_thread_id_required()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("resolve", "{}"));

        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("thread-id-required");
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Fact]
    public async Task Foreign_threadId_returns_404_thread_not_found()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("resolve", "{\"threadId\":\"PRRT_foreign\"}"));

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("thread-not-found");
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Fact]
    public async Task Resolve_success_publishes_event_and_200()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        ctx.Writer.NextResult = ReviewThreadResult.Ok;
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("resolve", KnownBody));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Writer.Calls.Should().ContainSingle().Which.Should().Be("resolve");
        await TestPoll.UntilAsync(
            () => ctx.Bus.Published.OfType<ReviewThreadResolutionChanged>().Any(),
            TimeSpan.FromSeconds(5),
            "ReviewThreadResolutionChanged should publish");
    }

    [Fact]
    public async Task Unresolve_success_returns_200_and_publishes_event()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        ctx.Writer.NextResult = ReviewThreadResult.Ok;
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("unresolve", KnownBody));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Writer.Calls.Should().ContainSingle().Which.Should().Be("unresolve");
        await TestPoll.UntilAsync(
            () => ctx.Bus.Published.OfType<ReviewThreadResolutionChanged>().Any(),
            TimeSpan.FromSeconds(5),
            "ReviewThreadResolutionChanged should publish");
    }

    [Fact]
    public async Task Writer_token_cannot_write_maps_to_403()
    {
        using var ctx = PrReviewThreadEndpointsTestContext.Create();
        ctx.Writer.NextResult = ReviewThreadResult.Fail(ReviewThreadErrorCode.TokenCannotWrite);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("resolve", KnownBody));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("token-cannot-write");
        ctx.Bus.Published.OfType<ReviewThreadResolutionChanged>().Should().BeEmpty();
    }
}
