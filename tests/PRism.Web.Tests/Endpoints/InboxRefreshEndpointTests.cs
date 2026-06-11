using System.Net;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class InboxRefreshEndpointTests
{
    private static InboxSnapshot MakeSnapshot(bool ciProbeComplete = true) =>
        new(
            new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
            new Dictionary<string, InboxItemEnrichment>(),
            DateTimeOffset.UtcNow,
            ciProbeComplete);

    // OriginCheckMiddleware rejects a POST without an Origin header; mirror ParseUrlEndpointTests.
    private static async Task<HttpResponseMessage> PostRefresh(HttpClient client)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/inbox/refresh", UriKind.Relative));
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        return await client.SendAsync(req);
    }

    [Fact]
    public async Task Post_refresh_invokes_RefreshAsync_and_returns_200()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        fakeOrch.RefreshCalls.Should().Be(1);
    }

    [Fact]
    public async Task Post_refresh_forwards_hardRefresh_true()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        fakeOrch.LastHardRefresh.Should().BeTrue("/api/inbox/refresh is a hard refresh (#355)");
    }

    [Fact]
    public async Task Post_refresh_returns_503_on_generic_failure()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator
        {
            Current = MakeSnapshot(),
            RefreshOverride = _ => throw new InvalidOperationException("boom"),
        };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/inbox/refresh-failed");
    }

    [Fact]
    public async Task Post_refresh_rate_limited_but_snapshot_advanced_returns_200()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        fakeOrch.RefreshOverride = _ =>
        {
            fakeOrch.Current = MakeSnapshot(ciProbeComplete: false); // advance Current (new reference)
            throw new RateLimitExceededException("ci probe 429", TimeSpan.FromSeconds(30));
        };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Post_refresh_rate_limited_without_commit_returns_503()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        fakeOrch.RefreshOverride = _ =>
            throw new RateLimitExceededException("section 429", TimeSpan.FromSeconds(30));
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/inbox/refresh-rate-limited");
    }
}
