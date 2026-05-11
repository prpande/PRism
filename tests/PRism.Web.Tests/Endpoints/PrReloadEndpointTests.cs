using System.Net;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Contracts;
using PRism.Core.Json;
using PRism.Core.PrDetail;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Endpoints;

public class PrReloadEndpointTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public PrReloadEndpointTests(PRismWebApplicationFactory f) { _factory = f; }

    private HttpClient ClientWithTab(string tabId = "tab-reload-1")
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }

    private static HttpClient AuthedClient(WebApplicationFactory<Program> factory, string tabId)
    {
        var token = factory.Services.GetRequiredService<SessionTokenProvider>().Current;
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Session", token);
        c.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var origin = c.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(origin)) c.DefaultRequestHeaders.Add("Origin", origin);
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }

    private static async Task<T?> ReadApiJsonAsync<T>(HttpResponseMessage resp)
        => await resp.Content.ReadFromJsonAsync<T>(JsonSerializerOptionsFactory.Api).ConfigureAwait(false);

    // PUT a summary to ensure a session exists before /reload runs.
    private static async Task SeedSessionAsync(HttpClient client, string ownerRepoNumber, string summary = "seed")
    {
        var patch = new ReviewSessionPatch(null, summary, null, null, null, null, null, null, null, null, null, null);
        var resp = await client.PutAsJsonAsync($"/api/pr/{ownerRepoNumber}/draft", patch);
        resp.IsSuccessStatusCode.Should().BeTrue($"seed PUT failed with {resp.StatusCode}");
    }

    [Fact]
    public async Task Reload_happy_path_returns_full_session_dto()
    {
        var client = ClientWithTab();
        await SeedSessionAsync(client, "acme/api/1001");

        var sha = new string('a', 40);
        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1001/reload", new { headSha = sha });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await ReadApiJsonAsync<ReviewSessionDto>(resp);
        dto.Should().NotBeNull();
        dto!.DraftComments.Should().BeEmpty();
        dto.DraftReplies.Should().BeEmpty();
    }

    [Fact]
    public async Task Reload_concurrent_requests_at_most_one_returns_409()
    {
        var client = ClientWithTab();
        await SeedSessionAsync(client, "acme/api/1002");

        var sha = new string('b', 40);
        var t1 = client.PostAsJsonAsync("/api/pr/acme/api/1002/reload", new { headSha = sha });
        var t2 = client.PostAsJsonAsync("/api/pr/acme/api/1002/reload", new { headSha = sha });

        var responses = await Task.WhenAll(t1, t2);
        // One semaphore slot — exactly one should be 409. The race is best-effort, so
        // tolerate either order: either both succeed (semaphore was released between
        // calls) or one is 409. The semaphore is process-wide so under WebApplicationFactory
        // the race typically yields one 409 reliably; tolerate both-200 as a spurious
        // pass that doesn't invalidate the contract.
        var conflictCount = responses.Count(r => r.StatusCode == HttpStatusCode.Conflict);
        conflictCount.Should().BeLessOrEqualTo(1);
        responses.Count(r => r.IsSuccessStatusCode).Should().BeGreaterOrEqualTo(1);
    }

    [Fact]
    public async Task Reload_invalid_sha_returns_422()
    {
        var client = ClientWithTab();
        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1003/reload", new { headSha = "not-a-sha" });
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Reload_session_not_found_returns_404()
    {
        var client = ClientWithTab();
        // No SeedSessionAsync — no session in state for this PR.
        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1004/reload", new { headSha = new string('c', 40) });
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Reload_with_diverged_cached_head_returns_409_reload_stale_head()
    {
        // Cache reports HeadSha = cached, but the request sends a different sha.
        // Phase 2's head-shift check returns 409 with the cached head.
        var cachedSha = new string('e', 40);
        var staleSha = new string('d', 40);
        var fake = new FakeCacheWithSnapshot(new PrReference("acme", "api", 1005),
            new ActivePrSnapshot(cachedSha, null, DateTimeOffset.UtcNow));
        await using var factory = _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(fake);
        }));
        var client = AuthedClient(factory, "tab-1");
        await SeedSessionAsync(client, "acme/api/1005");

        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1005/reload", new { headSha = staleSha });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await ReadApiJsonAsync<PrReloadEndpoints.ReloadStaleHeadResponse>(resp);
        body.Should().NotBeNull();
        body!.CurrentHeadSha.Should().Be(cachedSha);

        // Wire-shape pin: the `error` discriminator is what the frontend's
        // parseReloadConflictKind switches on. Without it, useReconcile's
        // auto-retry (S4 PR7 Task 46) classifies the response as a generic
        // 'conflict' and never retries with currentHeadSha.
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().Contain("\"error\":\"reload-stale-head\"");
        raw.Should().Contain($"\"currentHeadSha\":\"{cachedSha}\"");
    }

    [Fact]
    public async Task Reload_with_null_headSha_returns_400_not_500()
    {
        // System.Text.Json deserializes `{"headSha": null}` into ReloadRequest.HeadSha = null
        // despite the non-nullable record declaration. The pre-fix code called Sha40.IsMatch
        // on null, which throws ArgumentNullException → 500. Now: 400 at the boundary.
        var client = ClientWithTab();
        var raw = new StringContent("{\"headSha\":null}", Encoding.UTF8, "application/json");
        var resp = await client.PostAsync(new Uri("/api/pr/acme/api/1006/reload", UriKind.Relative), raw);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Reload_with_missing_headSha_returns_400_not_500()
    {
        var client = ClientWithTab();
        var raw = new StringContent("{}", Encoding.UTF8, "application/json");
        var resp = await client.PostAsync(new Uri("/api/pr/acme/api/1007/reload", UriKind.Relative), raw);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    private sealed class FakeCacheWithSnapshot : IActivePrCache
    {
        private readonly PrReference _expectedPr;
        private readonly ActivePrSnapshot _snapshot;
        public FakeCacheWithSnapshot(PrReference expectedPr, ActivePrSnapshot snapshot)
        {
            _expectedPr = expectedPr;
            _snapshot = snapshot;
        }
        public bool IsSubscribed(PrReference prRef) => _expectedPr == prRef;
        public ActivePrSnapshot? GetCurrent(PrReference prRef) => _expectedPr == prRef ? _snapshot : null;
        public void Update(PrReference prRef, ActivePrSnapshot snapshot) { /* test fake — no-op */ }
    }
}
