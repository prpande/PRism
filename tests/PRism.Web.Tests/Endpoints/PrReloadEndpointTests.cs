using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.Json;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Endpoints;
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

    private static HttpClient AuthedClient(WebApplicationFactory<Program> factory, string tabId) =>
        factory.CreateAuthenticatedClient(tabId);

    // Builds a per-test factory whose IActivePrCache returns a WARM snapshot for prRef with the
    // given head — the production happy-path precondition (#611): the poller has populated the
    // cache and its head matches the request. The shared IClassFixture _factory is a process-wide
    // singleton that can't take a per-test service override, so warm-cache tests derive their own
    // factory (mirrors Reload_with_diverged_cached_head). Caller owns disposal via `await using`.
    private WebApplicationFactory<Program> WithWarmCache(PrReference prRef, string headSha) =>
        _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(
                new FakeCacheWithSnapshot(prRef, new ActivePrSnapshot(headSha, null, DateTimeOffset.UtcNow)));
        }));

    // Builds a per-test factory whose IActivePrCache returns a stale snapshot (head `cachedHead`)
    // AND whose IActivePrBatchReader serves the authoritative GitHub head (#634). The diverged
    // branch now consults the batch reader for the authoritative head rather than trusting the
    // cache; every test that reaches that branch MUST register a fake batch reader, since the
    // default factory wires the REAL GitHubActivePrBatchReader (a live network call to the
    // nonexistent acme/api/NNNN repo would otherwise turn the asserted 409/200 into a transport
    // failure). Caller owns disposal via `await using`.
    private WebApplicationFactory<Program> WithCacheAndBatch(
        PrReference prRef, string cachedHead, IActivePrBatchReader batch) =>
        _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(
                new FakeCacheWithSnapshot(prRef, new ActivePrSnapshot(cachedHead, null, DateTimeOffset.UtcNow)));
            s.RemoveAll<IActivePrBatchReader>();
            s.AddSingleton(batch);
        }));

    private static async Task<T?> ReadApiJsonAsync<T>(HttpResponseMessage resp)
        => await resp.Content.ReadFromJsonAsync<T>(JsonSerializerOptionsFactory.Api).ConfigureAwait(false);

    // PUT a verdict to ensure a session exists before /reload runs. V7 unification — the legacy
    // `draftSummaryMarkdown: "seed"` is gone; a `draftVerdict: "approve"` patch materialises an
    // otherwise-empty session, preserving the existing Reload_happy_path assertion that
    // DraftComments is empty (a `newPrRootDraftComment` would have added a row instead).
    private static async Task SeedSessionAsync(HttpClient client, string ownerRepoNumber)
    {
        var patch = new ReviewSessionPatch(
            DraftVerdict: "approve",
            null, null, null, null, null, null, null, null, null, null);
        var resp = await client.PutAsJsonAsync($"/api/pr/{ownerRepoNumber}/draft", patch);
        resp.IsSuccessStatusCode.Should().BeTrue($"seed PUT failed with {resp.StatusCode}");
    }

    [Fact]
    public async Task Reload_happy_path_returns_full_session_dto()
    {
        // Production happy path: the active-PR cache is warm and its head matches the request, so
        // reconcile proceeds and returns the session DTO (#611 AC3). Pre-#611 this passed against
        // the default COLD cache via the now-closed head-shift bypass; it must now register a
        // populated cache to exercise the real matching-head path.
        var sha = new string('a', 40);
        var prRef = new PrReference("acme", "api", 1001);
        await using var factory = WithWarmCache(prRef, sha);
        var client = AuthedClient(factory, "tab-reload-1");
        await SeedSessionAsync(client, "acme/api/1001");

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
        var sha = new string('b', 40);
        var prRef = new PrReference("acme", "api", 1002);
        await using var factory = WithWarmCache(prRef, sha);
        var client = AuthedClient(factory, "tab-reload-1");
        await SeedSessionAsync(client, "acme/api/1002");

        // Inline the two POSTs into WhenAll (no escaping task locals) so the in-flight
        // requests are guaranteed complete before `await using` disposes the factory (CA2025).
        var responses = await Task.WhenAll(
            client.PostAsJsonAsync("/api/pr/acme/api/1002/reload", new { headSha = sha }),
            client.PostAsJsonAsync("/api/pr/acme/api/1002/reload", new { headSha = sha }));
        // One semaphore slot — at most one should be 409 (reload-in-progress); the other reconciles
        // against the warm matching head and returns 200. The race is best-effort, so tolerate either
        // order: either both succeed (semaphore released between calls) or one is 409. The semaphore is
        // process-wide so under WebApplicationFactory the race typically yields one 409 reliably;
        // tolerate both-200 as a spurious pass that doesn't invalidate the contract.
        var conflictCount = responses.Count(r => r.StatusCode == HttpStatusCode.Conflict);
        conflictCount.Should().BeLessOrEqualTo(1);
        responses.Count(r => r.IsSuccessStatusCode).Should().BeGreaterOrEqualTo(1);
    }

    [Fact]
    public async Task Reload_writes_tab_stamp_under_caller_tab_id()
    {
        // Spec § 5.3 — the per-tab stamp lands under X-PRism-Tab-Id (not "tab-PLACEHOLDER").
        var sha = new string('f', 40);
        var prRef = new PrReference("acme", "api", 1100);
        await using var factory = WithWarmCache(prRef, sha);
        var client = AuthedClient(factory, "tab-RELOAD");
        await SeedSessionAsync(client, "acme/api/1100");

        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1100/reload", new { headSha = sha });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var stateStore = factory.Services.GetRequiredService<IAppStateStore>();
        var state = await stateStore.LoadAsync(CancellationToken.None);
        var stamps = state.Reviews.Sessions["acme/api/1100"].TabStamps;
        stamps.Should().ContainKey("tab-RELOAD");
        stamps["tab-RELOAD"].HeadSha.Should().Be(sha);
    }

    [Fact]
    public async Task Reload_returns_422_when_tab_id_header_missing()
    {
        // Reload is a write site; tab-id gate fires before the headSha format check.
        var c = _factory.CreateClient();   // deliberately no X-PRism-Tab-Id
        var sha = new string('a', 40);
        var resp = await c.PostAsJsonAsync("/api/pr/acme/api/1101/reload", new { headSha = sha });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        var body = await resp.Content.ReadAsStringAsync();
        body.Should().Contain("reload-tab-id-missing");
    }

    [Theory]
    [InlineData("tab id with space")]
    [InlineData("tab/with/slash")]
    public async Task Reload_returns_422_when_tab_id_header_is_invalid(string tabId)
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        var sha = new string('a', 40);
        var resp = await c.PostAsJsonAsync("/api/pr/acme/api/1102/reload", new { headSha = sha });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("reload-tab-id-missing");
    }

    [Fact]
    public async Task Reload_invalid_sha_returns_422()
    {
        var client = ClientWithTab();
        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1003/reload", new { headSha = "not-a-sha" });
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Reload_uppercase_sha_is_accepted_not_422()
    {
        var client = ClientWithTab();
        var upper = new string('A', 40); // 40 uppercase hex — rejected on main (lowercase-only regex)

        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1003/reload", new { headSha = upper });

        // The point: it must NOT be rejected as sha-format-invalid. Any downstream
        // outcome (no-session 404, conflict, ok) is fine — just not the 422 format reject.
        resp.StatusCode.Should().NotBe(HttpStatusCode.UnprocessableEntity);
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
        // Cache reports HeadSha = cached, the request sends a different sha, and GitHub's
        // authoritative head (served by the batch reader) is a THIRD distinct sha. #634: the
        // diverged branch must return GitHub's head — NOT the cached head — as the retry target.
        var cachedSha = new string('e', 40);
        var staleSha = new string('d', 40);
        var githubSha = new string('f', 40); // authoritative; distinct from cached + request
        var prRef = new PrReference("acme", "api", 1005);
        await using var factory = WithCacheAndBatch(prRef, cachedSha, new FakeBatchReader(prRef, githubSha));
        var client = AuthedClient(factory, "tab-1");
        await SeedSessionAsync(client, "acme/api/1005");

        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1005/reload", new { headSha = staleSha });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var body = await ReadApiJsonAsync<PrReloadEndpoints.ReloadStaleHeadResponse>(resp);
        body.Should().NotBeNull();
        body!.CurrentHeadSha.Should().Be(githubSha); // authoritative head, not the cached sha

        // Wire-shape pin: the `error` discriminator is what the frontend's
        // parseReloadConflictKind switches on. Without it, useReconcile's
        // auto-retry (S4 PR7 Task 46) classifies the response as a generic
        // 'conflict' and never retries with currentHeadSha.
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().Contain("\"error\":\"reload-stale-head\"");
        raw.Should().Contain($"\"currentHeadSha\":\"{githubSha}\"");
        raw.Should().NotContain(cachedSha); // the stale cached head is never the retry target
    }

    [Fact]
    public async Task Reload_diverged_but_client_head_is_authoritative_returns_200()
    {
        // #634 AC1+AC3: the cache lags (head C), but GitHub's authoritative head equals the
        // client's request head — so the client head is current and the cache was merely stale.
        // Reconcile must PROCEED (200), not return a 409 against the staler cached head.
        // Red on main: main's diverged branch returns 409 with the cached head regardless of GitHub.
        var cachedSha = new string('c', 40); // stale cache
        var clientSha = new string('a', 40); // client head == GitHub's actual head
        var prRef = new PrReference("acme", "api", 1300);
        await using var factory = WithCacheAndBatch(prRef, cachedSha, new FakeBatchReader(prRef, clientSha));
        var client = AuthedClient(factory, "tab-1");
        await SeedSessionAsync(client, "acme/api/1300");

        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1300/reload", new { headSha = clientSha });

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await ReadApiJsonAsync<ReviewSessionDto>(resp);
        dto.Should().NotBeNull();
    }

    [Fact]
    public async Task Reload_diverged_returns_409_with_github_head_not_cached_head()
    {
        // #634 AC2: cache (C), client (R), and GitHub's authoritative head (G) are all distinct.
        // The retry target must be G (GitHub), never C (the cache). Red on main: main returns C.
        var cachedSha = new string('c', 40);
        var clientSha = new string('d', 40);
        var githubSha = new string('e', 40); // authoritative, differs from both
        var prRef = new PrReference("acme", "api", 1301);
        await using var factory = WithCacheAndBatch(prRef, cachedSha, new FakeBatchReader(prRef, githubSha));
        var client = AuthedClient(factory, "tab-1");
        await SeedSessionAsync(client, "acme/api/1301");

        var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1301/reload", new { headSha = clientSha });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().Contain("\"error\":\"reload-stale-head\"");
        raw.Should().Contain($"\"currentHeadSha\":\"{githubSha}\"");
        raw.Should().NotContain(cachedSha);
    }

    // #634 AC4: when the authoritative read is unavailable the diverged branch degrades to today's
    // behavior — return the CACHED head — rather than a new 500, for ANY read failure (rate-limit OR
    // transport/poison), not just rate-limit. And like every refusal branch it writes no tab stamp and
    // publishes no StateChanged (the guard returns before store.UpdateAsync's apply transform). The
    // rate-limit case passes on main too (main never calls the batch reader); the transport case is
    // RED against a catch that only handles RateLimitExceededException (the exception would propagate
    // to a 500), pinning the broadened catch.
    [Fact]
    public Task Reload_diverged_rate_limited_read_falls_back_to_cached_head_no_side_effects() =>
        AssertReadUnavailableFallsBackToCachedHead(prNumber: 1302, tabId: "tab-fb",
            makeBatch: pr => new FakeBatchReader(pr, head: null,
                throwOnPoll: new RateLimitExceededException("rate limited (test)", null)));

    [Fact]
    public Task Reload_diverged_transport_error_read_falls_back_to_cached_head_no_side_effects() =>
        AssertReadUnavailableFallsBackToCachedHead(prNumber: 1303, tabId: "tab-fb2",
            makeBatch: pr => new FakeBatchReader(pr, head: null,
                throwOnPoll: new HttpRequestException("transport failure (test)")));

    [Fact]
    public Task Reload_diverged_per_alias_drop_falls_back_to_cached_head_no_side_effects() =>
        // GitHub dropped this PR from the batch result (empty dict, no throw — the poller's per-alias
        // "keep last-known" contract). authoritative is null → fall back to the cached head, the third
        // unavailability mode the spec enumerates alongside rate-limit + transport.
        AssertReadUnavailableFallsBackToCachedHead(prNumber: 1304, tabId: "tab-fb3",
            makeBatch: pr => new FakeBatchReader(pr, head: null));

    private async Task AssertReadUnavailableFallsBackToCachedHead(
        int prNumber, string tabId, Func<PrReference, FakeBatchReader> makeBatch)
    {
        var cachedSha = new string('c', 40);
        var clientSha = new string('d', 40);
        var prRef = new PrReference("acme", "api", prNumber);
        var refKey = $"acme/api/{prNumber}";
        var fakeBus = new FakeReviewEventBus();
        // Reuse WithCacheAndBatch for the cache+batch wiring (WithWebHostBuilder stacks); add only
        // the bus override this no-side-effects assertion needs.
        await using var factory =
            WithCacheAndBatch(prRef, cachedSha, makeBatch(prRef))
                .WithWebHostBuilder(b => b.ConfigureServices(s =>
                {
                    s.RemoveAll<IReviewEventBus>();
                    s.AddSingleton<IReviewEventBus>(fakeBus);
                }));
        var client = AuthedClient(factory, tabId);
        await SeedSessionAsync(client, refKey);
        fakeBus.Clear(); // drop events emitted by the seed PUT

        var resp = await client.PostAsJsonAsync($"/api/pr/{refKey}/reload", new { headSha = clientSha });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().Contain("\"error\":\"reload-stale-head\"");
        raw.Should().Contain($"\"currentHeadSha\":\"{cachedSha}\""); // fell back to the cached head

        var stateStore = factory.Services.GetRequiredService<IAppStateStore>();
        var state = await stateStore.LoadAsync(CancellationToken.None);
        state.Reviews.Sessions[refKey].TabStamps.Should().NotContainKey(tabId);
        fakeBus.Published.OfType<StateChanged>().Should().BeEmpty();
    }

    [Fact]
    public async Task Reload_with_cold_null_cache_returns_409_reload_head_unverified()
    {
        // #611: the cache is COLD (GetCurrent → null) — the poller hasn't populated a snapshot for
        // this PR yet (subscribe→poll race) or it was cleared by POST /api/auth/replace. The
        // head-shift guard cannot verify request.HeadSha against a known-good head, so reload must
        // NOT reconcile against the unverified client head; it returns a retryable
        // 409 reload-head-unverified. Red on main: the cold-cache bypass returns 200 (silent
        // reconcile against the unverified head) instead.
        // AllSubscribedActivePrCache with its default (Current == null) models a cold cache:
        // IsSubscribed → true (subscribe→poll race) but GetCurrent → null (no snapshot yet).
        await using var factory = _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new AllSubscribedActivePrCache());
        }));
        var client = AuthedClient(factory, "tab-cold");
        await SeedSessionAsync(client, "acme/api/1200");

        var resp = await client.PostAsJsonAsync(
            "/api/pr/acme/api/1200/reload", new { headSha = new string('a', 40) });

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().Contain("\"error\":\"reload-head-unverified\"");
        // Distinct from reload-stale-head: there is no currentHeadSha to retry with.
        raw.Should().NotContain("currentHeadSha");
    }

    [Fact]
    public async Task Reload_cold_null_cache_writes_no_tab_stamp_and_publishes_no_state_changed()
    {
        // #611 AC4: the cold-cache 409 returns from the UpdateAsync transform before the apply, so
        // it writes no per-tab stamp and (via the updatedSession-null gate) publishes no
        // StateChanged — a no-op reload must not trigger a spurious FE refetch. Red on main: the
        // silent reconcile both stamps the caller's tab and publishes StateChanged.
        var fakeBus = new FakeReviewEventBus();
        await using var factory = _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(new AllSubscribedActivePrCache()); // Current == null → cold
            s.RemoveAll<IReviewEventBus>();
            s.AddSingleton<IReviewEventBus>(fakeBus);
        }));
        var client = AuthedClient(factory, "tab-cold-2");
        await SeedSessionAsync(client, "acme/api/1201");
        fakeBus.Clear(); // drop events emitted by the seed PUT

        var resp = await client.PostAsJsonAsync(
            "/api/pr/acme/api/1201/reload", new { headSha = new string('a', 40) });
        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);

        var stateStore = factory.Services.GetRequiredService<IAppStateStore>();
        var state = await stateStore.LoadAsync(CancellationToken.None);
        state.Reviews.Sessions["acme/api/1201"].TabStamps.Should().NotContainKey("tab-cold-2");
        fakeBus.Published.OfType<StateChanged>().Should().BeEmpty();
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
        public void Clear() { /* test fake — no-op */ }
    }

    // Test-only IActivePrBatchReader (#634). Models GitHub's authoritative head for the diverged
    // branch's read. `head == null` models a per-alias drop (the PR is absent from the batch
    // result — the poller's "keep last-known" contract); `throwOnPoll` throws the given exception
    // to model a failed read (rate-limit, transport, poison). All unavailable cases drive the
    // endpoint's fall-back-to-cached-head path.
    private sealed class FakeBatchReader : IActivePrBatchReader
    {
        private readonly PrReference _pr;
        private readonly string? _head;
        private readonly Exception? _throwOnPoll;
        public FakeBatchReader(PrReference pr, string? head, Exception? throwOnPoll = null)
        {
            _pr = pr;
            _head = head;
            _throwOnPoll = throwOnPoll;
        }
        public Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
            IReadOnlyList<PrReference> refs, CancellationToken ct)
        {
            if (_throwOnPoll is not null)
                throw _throwOnPoll;
            var dict = new Dictionary<PrReference, ActivePrPollSnapshot>();
            if (_head is not null)
                dict[_pr] = new ActivePrPollSnapshot(_head, "", "MERGEABLE", PrState.Open, 0, 0);
            return Task.FromResult<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>>(dict);
        }
    }
}
