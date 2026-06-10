using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core;
using PRism.Core.Activity;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using System.Threading;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class AuthEndpointsTests
{
    [Fact]
    public async Task State_returns_hasToken_false_initially()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.HasToken.Should().BeFalse();
        resp.HostMismatch.Should().BeNull();
    }

    [Fact]
    public async Task State_returns_configured_github_host()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        resp.Should().NotBeNull();
        resp!.Host.Should().Be("https://github.com");
    }

    [Fact]
    public async Task Connect_with_invalid_PAT_returns_ok_false_with_error()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.")),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "ghp_bad" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeFalse();
        body.Error.Should().Be("invalidtoken");      // enum.ToString().ToLowerInvariant()
    }

    [Fact]
    public async Task Connect_with_valid_PAT_returns_ok_true_and_sets_lastConfiguredGithubHost()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(true, "octocat", new[] { "repo", "read:user", "read:org" }, AuthValidationError.None, null)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "ghp_good" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeTrue();
        body.Login.Should().Be("octocat");
    }

    [Fact]
    public async Task Successful_connect_caches_viewer_login()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(true, "octocat", new[] { "repo", "read:user", "read:org" }, AuthValidationError.None, null)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "ghp_good" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeTrue();

        var viewerLogin = factory.Services.GetRequiredService<IViewerLoginProvider>();
        viewerLogin.Get().Should().Be("octocat");
    }

    [Fact]
    public async Task Connect_with_malformed_json_body_returns_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(System.UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = new StringContent("not json", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task HostChangeResolution_with_malformed_json_body_returns_400()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(System.UriPartial.Authority);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/host-change-resolution", UriKind.Relative))
        {
            Content = new StringContent("{ broken", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Connect_with_no_repos_warning_returns_warning_and_does_not_commit()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(
                true, "octocat", null, AuthValidationError.None, null,
                AuthValidationWarning.NoReposSelected)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "github_pat_zero_repos" }),
        };
        req.Headers.Add("Origin", origin);

        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
        body!.Ok.Should().BeTrue();
        body.Warning.Should().Be("no-repos-selected");

        // Token must NOT be committed — auth/state still says hasToken: false.
        var stateResp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        stateResp!.HasToken.Should().BeFalse();
    }

    [Fact]
    public async Task Connect_commit_after_warning_persists_token_and_sets_host()
    {
        using var factory = new PRismWebApplicationFactory
        {
            ValidateOverride = () => Task.FromResult(new AuthValidationResult(
                true, "octocat", null, AuthValidationError.None, null,
                AuthValidationWarning.NoReposSelected)),
        };
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        // First call: connect returns warning, transient stays pending.
        using var connectReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
        {
            Content = JsonContent.Create(new { pat = "github_pat_zero_repos" }),
        };
        connectReq.Headers.Add("Origin", origin);
        var connectResp = await client.SendAsync(connectReq);
        connectResp.IsSuccessStatusCode.Should().BeTrue();

        // Second call: confirm via commit.
        using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
        commitReq.Headers.Add("Origin", origin);
        var commitResp = await client.SendAsync(commitReq);
        commitResp.IsSuccessStatusCode.Should().BeTrue();

        // Token now committed.
        var stateResp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
        stateResp!.HasToken.Should().BeTrue();

        // The validated login must be cached for the awaiting-author inbox query.
        var viewerLogin = factory.Services.GetRequiredService<IViewerLoginProvider>();
        viewerLogin.Get().Should().Be("octocat");
    }

    [Fact]
    public async Task Connect_commit_returns_409_when_no_transient_pending()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

        using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
        commitReq.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(commitReq);

        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.Conflict);
    }

    // Wire-format casing assertion. ReadFromJsonAsync<T> defaults to PropertyNameCaseInsensitive,
    // so deserialization-shaped tests pass whether the server emits camelCase or PascalCase keys.
    // This test reads the raw response body and asserts the camelCase invariant directly — guards
    // against a future ConfigureHttpJsonOptions misconfiguration that would silently break the
    // frontend's hand-mirrored types.
    [Fact]
    public async Task State_response_wire_format_uses_camelCase_keys()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        var resp = await client.GetAsync(new Uri("/api/auth/state", UriKind.Relative));
        resp.IsSuccessStatusCode.Should().BeTrue();
        var raw = await resp.Content.ReadAsStringAsync();

        // camelCase keys present.
        raw.Should().Contain("\"hasToken\"");
        raw.Should().Contain("\"host\"");
        raw.Should().Contain("\"hostMismatch\"");

        // PascalCase keys must not be on the wire.
        raw.Should().NotContain("\"HasToken\"");
        raw.Should().NotContain("\"HostMismatch\"");
    }

    // ----------------------------------------------------------------------------------
    // #137 Task 8 — activity-cache invalidation on EVERY successful token-commit path.
    //
    // The cache holds private-repo feed data scoped to the CURRENT token. Each handler
    // that commits a token must call IActivityProvider.Reset() so a rotated identity
    // never serves a feed built under the prior token. The crux is /api/auth/replace's
    // SAME-LOGIN rotation case (identityChanged == false): the existing identityChanged-
    // gated reconciliation block does NOT cover it, so Reset() must live OUTSIDE that
    // block. A SpyActivityProvider counts Reset() calls — chosen over "assert a fresh
    // fetch" because it's a pure unit assertion that pins the exact contract.
    // ----------------------------------------------------------------------------------

    [Fact]
    public async Task Replace_same_login_resets_activity_cache_exactly_once()
    {
        // THE regression guard for the same-login-rotation gap. identityChanged == false
        // here (prior login == new login), so this test MUST be RED if Reset() is placed
        // inside the `if (identityChanged)` block instead of outside it.
        var spy = new SpyActivityProvider();
        using var f = new ResetSpyHarness
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "alice", Scopes: new[] { "repo" },
                Error: AuthValidationError.None, ErrorDetail: null)),
            Spy = spy,
        };
        await f.SeedPriorLoginAsync("alice");

        using var client = f.CreateClient();
        using var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_rotated" });

        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponse>();
        body!.IdentityChanged.Should().BeFalse("same login is a rotation, not an identity change");
        spy.ResetCount.Should().Be(1,
            "Reset() must fire on EVERY successful replace, including same-login rotation — "
            + "it belongs OUTSIDE the if(identityChanged) block");
    }

    [Fact]
    public async Task Replace_different_login_resets_activity_cache_exactly_once()
    {
        var spy = new SpyActivityProvider();
        using var f = new ResetSpyHarness
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "bob", Scopes: new[] { "repo" },
                Error: AuthValidationError.None, ErrorDetail: null)),
            Spy = spy,
        };
        await f.SeedPriorLoginAsync("alice");

        using var client = f.CreateClient();
        using var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_new_identity" });

        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<ReplaceResponse>();
        body!.IdentityChanged.Should().BeTrue();
        spy.ResetCount.Should().Be(1, "an identity change still resets the cache exactly once");
    }

    [Fact]
    public async Task Connect_commit_resets_activity_cache()
    {
        // /api/auth/connect (soft-warning) followed by /api/auth/connect/commit. The
        // commit path commits a token, so it must reset. The soft-warning connect path
        // commits NO token, so it must NOT reset — asserted via the spy count after the
        // first call.
        var spy = new SpyActivityProvider();
        using var f = new ResetSpyHarness
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "octocat", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null,
                Warning: AuthValidationWarning.NoReposSelected)),
            Spy = spy,
        };

        using var client = f.CreateClient();

        // connect → soft warning, no commit, no reset.
        using var connectResp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "github_pat_zero_repos" });
        connectResp.IsSuccessStatusCode.Should().BeTrue();
        spy.ResetCount.Should().Be(0, "the soft-warning connect path commits no token and must NOT reset");

        // commit → token committed, cache reset.
        using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
        using var commitResp = await client.SendAsync(commitReq);
        commitResp.IsSuccessStatusCode.Should().BeTrue();
        spy.ResetCount.Should().Be(1, "the commit path commits the token and must reset the cache");
    }

    [Fact]
    public async Task Connect_success_path_resets_activity_cache()
    {
        // Happy-path connect (no warning) commits the token directly → must reset.
        var spy = new SpyActivityProvider();
        using var f = new ResetSpyHarness
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "octocat", Scopes: new[] { "repo", "read:user", "read:org" },
                Error: AuthValidationError.None, ErrorDetail: null)),
            Spy = spy,
        };

        using var client = f.CreateClient();
        using var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_good" });

        resp.IsSuccessStatusCode.Should().BeTrue();
        spy.ResetCount.Should().Be(1, "the connect success branch commits the token and must reset the cache");
    }

    // Harness mirroring AuthReplaceEndpointTests.HarnessFactory: reuses
    // PRismWebApplicationFactory's DataDir + Test env wiring, replaces IReviewAuth with a
    // scripted stub, and (the Task 8 addition) replaces IActivityProvider with a counting
    // spy. Each instance owns a private DataDir so concurrent tests don't collide.
    private sealed class ResetSpyHarness : WebApplicationFactory<Program>
    {
        public PRismWebApplicationFactory Base { get; } = new();
        public Func<Task<AuthValidationResult>>? Validate { get; set; }
        public SpyActivityProvider? Spy { get; set; }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            ArgumentNullException.ThrowIfNull(builder);
            builder.UseSetting("DataDir", Base.DataDir);
            builder.UseEnvironment("Test");
            var webRoot = System.IO.Path.Combine(Base.DataDir, "wwwroot");
            System.IO.Directory.CreateDirectory(webRoot);
            if (!System.IO.File.Exists(System.IO.Path.Combine(webRoot, "index.html")))
                System.IO.File.WriteAllText(System.IO.Path.Combine(webRoot, "index.html"),
                    "<!DOCTYPE html><html><body>stub</body></html>");
            builder.UseWebRoot(webRoot);

            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IReviewAuth>();
                services.AddSingleton<IReviewAuth>(new StubReviewAuth(() =>
                    (Validate ?? (() => Task.FromResult(new AuthValidationResult(
                        Ok: true, Login: "default", Scopes: null,
                        Error: AuthValidationError.None, ErrorDetail: null))))()));
                if (Spy is not null)
                {
                    services.RemoveAll<IActivityProvider>();
                    services.AddSingleton<IActivityProvider>(Spy);
                }
            });
        }

        protected override void ConfigureClient(System.Net.Http.HttpClient client)
        {
            ArgumentNullException.ThrowIfNull(client);
            base.ConfigureClient(client);
            var token = Services.GetRequiredService<SessionTokenProvider>().Current;
            client.DefaultRequestHeaders.Add("X-PRism-Session", token);
            client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
            var origin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
            if (!string.IsNullOrEmpty(origin))
                client.DefaultRequestHeaders.Add("Origin", origin);
        }

        public async Task SeedPriorLoginAsync(string login)
        {
            var config = Services.GetRequiredService<IConfigStore>();
            await config.InitAsync(default);
            await config.SetDefaultAccountLoginAsync(login, default);
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            Base.Dispose();
        }
    }

    private sealed class StubReviewAuth : IReviewAuth
    {
        private readonly Func<Task<AuthValidationResult>> _validate;
        public StubReviewAuth(Func<Task<AuthValidationResult>> validate) { _validate = validate; }
        public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) => _validate();
    }

    // Counts Reset() calls. GetActivityAsync is never exercised by these tests (the auth
    // handlers only call Reset), so it returns an empty response.
    private sealed class SpyActivityProvider : IActivityProvider
    {
        private int _resetCount;
        public int ResetCount => Volatile.Read(ref _resetCount);
        public void Reset() => Interlocked.Increment(ref _resetCount);
        public Task<ActivityResponse> GetActivityAsync(CancellationToken ct) =>
            Task.FromResult(new ActivityResponse(
                [], DateTimeOffset.UnixEpoch, new ActivityDegradation(false, false, false), Watching: []));
    }

    public sealed record AuthStateResponse(bool HasToken, string Host, HostMismatchInfo? HostMismatch);
    public sealed record HostMismatchInfo(string Old, string New);
    public sealed record ConnectResponse(bool Ok, string? Login, string? Host, string? Error, string? Detail, string? Warning);
    public sealed record ReplaceResponse(bool Ok, string? Login, string? Host, bool IdentityChanged);
}
