using System.IO;
using System.Net.Http.Json;
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
using PRism.Core.Inbox;
using PRism.Core.Storage;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// #619 — spec tests 15b + 15c: the auth token-change handlers evict both cold-start caches
// (awaited) at every successful commit, including the same-login rotation case where
// IdentityChanged does NOT fire. The cross-identity boundary is security-sensitive: the
// eviction must run even if the config-login persist fails (fail-closed / best-effort pattern).
public class AuthCacheEvictionTests
{
    [Fact] // test 15b — /replace SAME-LOGIN rotation evicts both caches (IdentityChanged does NOT fire here)
    public async Task Replace_same_login_rotation_evicts_both_caches()
    {
        var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
        var activityCache = new RecordingIdentityCache<ActivityResponse>();
        using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat", priorLogin: "octocat");
        var client = f.CreateAuthenticatedClient();

        var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_new" });
        resp.EnsureSuccessStatusCode();

        inboxCache.EvictCount.Should().BeGreaterThan(0);
        activityCache.EvictCount.Should().BeGreaterThan(0);
    }

    [Fact] // test 15b — /connect (no-warning) evicts both caches
    public async Task Connect_evicts_both_caches()
    {
        var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
        var activityCache = new RecordingIdentityCache<ActivityResponse>();
        using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat");
        var client = f.CreateAuthenticatedClient();

        var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_x" });
        resp.EnsureSuccessStatusCode();

        inboxCache.EvictCount.Should().BeGreaterThan(0);
        activityCache.EvictCount.Should().BeGreaterThan(0);
    }

    [Fact] // test 15b — /connect/commit (post-warning commit) evicts both caches (round-1 SEC-2)
    public async Task Connect_commit_after_warning_evicts_both_caches()
    {
        var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
        var activityCache = new RecordingIdentityCache<ActivityResponse>();
        // Validator returns a soft warning (NoReposSelected) so /connect does NOT commit; the commit
        // (and thus the eviction) happens at /connect/commit. Mirrors the existing
        // Connect_commit_after_warning_persists_token_and_sets_host test's two-step flow.
        using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat",
            validationWarning: AuthValidationWarning.NoReposSelected);
        var client = f.CreateAuthenticatedClient();

        (await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_warn" })).EnsureSuccessStatusCode();
        inboxCache.EvictCount.Should().Be(0); // not yet — connect returned a warning, no commit

        (await client.PostAsJsonAsync("/api/auth/connect/commit", new { })).EnsureSuccessStatusCode();
        inboxCache.EvictCount.Should().BeGreaterThan(0);   // evicted at commit
        activityCache.EvictCount.Should().BeGreaterThan(0);
    }

    [Fact] // test 15c — fail-closed: a config-write failure on token change still evicts
    public async Task Token_change_still_evicts_when_config_write_throws()
    {
        var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
        var activityCache = new RecordingIdentityCache<ActivityResponse>();
        using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat",
            configWriteThrows: true);
        var client = f.CreateAuthenticatedClient();

        var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_x" });
        resp.EnsureSuccessStatusCode();

        inboxCache.EvictCount.Should().BeGreaterThan(0); // evict precedes/decoupled from the config write
    }

    // ─── harness factory helper ───────────────────────────────────────────────────────────────────

    private static CacheEvictionHarness FactoryWithCaches(
        IIdentityKeyedFileCache<InboxSnapshot> inboxCache,
        IIdentityKeyedFileCache<ActivityResponse> activityCache,
        string validatedLogin = "octocat",
        string? priorLogin = null,
        AuthValidationWarning validationWarning = AuthValidationWarning.None,
        bool configWriteThrows = false)
    {
        var harness = new CacheEvictionHarness(inboxCache, activityCache, validatedLogin, validationWarning, configWriteThrows);
        if (priorLogin is not null)
        {
            var config = harness.Services.GetRequiredService<IConfigStore>();
            config.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
            config.SetDefaultAccountLoginAsync(priorLogin, CancellationToken.None).GetAwaiter().GetResult();
        }
        return harness;
    }

    // ─── harness ─────────────────────────────────────────────────────────────────────────────────

    private sealed class CacheEvictionHarness : WebApplicationFactory<Program>
    {
        private readonly IIdentityKeyedFileCache<InboxSnapshot> _inboxCache;
        private readonly IIdentityKeyedFileCache<ActivityResponse> _activityCache;
        private readonly string _validatedLogin;
        private readonly AuthValidationWarning _validationWarning;
        private readonly bool _configWriteThrows;

        // Provides the DataDir + Test environment wiring (mirrors AuthReplaceEndpointTests.HarnessFactory).
        public PRismWebApplicationFactory Base { get; } = new();

        public CacheEvictionHarness(
            IIdentityKeyedFileCache<InboxSnapshot> inboxCache,
            IIdentityKeyedFileCache<ActivityResponse> activityCache,
            string validatedLogin,
            AuthValidationWarning validationWarning,
            bool configWriteThrows)
        {
            _inboxCache = inboxCache;
            _activityCache = activityCache;
            _validatedLogin = validatedLogin;
            _validationWarning = validationWarning;
            _configWriteThrows = configWriteThrows;
        }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            ArgumentNullException.ThrowIfNull(builder);
            builder.UseSetting("DataDir", Base.DataDir);
            builder.UseEnvironment("Test");

            var webRoot = Path.Combine(Base.DataDir, "wwwroot");
            Directory.CreateDirectory(webRoot);
            if (!File.Exists(Path.Combine(webRoot, "index.html")))
                File.WriteAllText(Path.Combine(webRoot, "index.html"),
                    "<!DOCTYPE html><html><body>stub</body></html>");
            builder.UseWebRoot(webRoot);

            builder.ConfigureServices(services =>
            {
                // Script the validator so handlers reach the commit/eviction path.
                services.RemoveAll<IReviewAuth>();
                services.AddSingleton<IReviewAuth>(new StubReviewAuth(() =>
                    Task.FromResult(new AuthValidationResult(
                        Ok: true, Login: _validatedLogin, Scopes: new[] { "repo" },
                        Error: AuthValidationError.None, ErrorDetail: null,
                        Warning: _validationWarning))));

                // Inject recording caches so we can observe EvictAsync calls.
                services.RemoveAll<IIdentityKeyedFileCache<InboxSnapshot>>();
                services.AddSingleton<IIdentityKeyedFileCache<InboxSnapshot>>(_inboxCache);

                services.RemoveAll<IIdentityKeyedFileCache<ActivityResponse>>();
                services.AddSingleton<IIdentityKeyedFileCache<ActivityResponse>>(_activityCache);

                // When configWriteThrows=true, replace IConfigStore with a wrapper whose
                // SetDefaultAccountLoginAsync always throws, to prove the eviction is fail-closed.
                if (_configWriteThrows)
                {
                    services.RemoveAll<IConfigStore>();
                    services.AddSingleton<IConfigStore>(new ThrowingConfigStore());
                }
            });
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            Base.Dispose();
        }
    }

    // ─── ThrowingConfigStore ──────────────────────────────────────────────────────────────────────

    // Delegates everything to a real ConfigStore, except SetDefaultAccountLoginAsync which always
    // throws — used by Token_change_still_evicts_when_config_write_throws (test 15c) to prove
    // eviction is fail-closed independent of the config-login persist.
    private sealed class ThrowingConfigStore : IConfigStore, IDisposable
    {
        private readonly PRism.Core.Config.ConfigStore _inner;

        public ThrowingConfigStore()
        {
            var dataDir = TempDataDir.NewPath("PRism-evict-throw");
            Directory.CreateDirectory(dataDir);
            _inner = new PRism.Core.Config.ConfigStore(dataDir);
            _inner.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
        }

        public PRism.Core.Config.AppConfig Current => _inner.Current;
        public string ConfigPath => _inner.ConfigPath;
        public Exception? LastLoadError => _inner.LastLoadError;
        public Task InitAsync(CancellationToken ct) => _inner.InitAsync(ct);
        public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) =>
            _inner.PatchAsync(patch, ct);
        public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) =>
            throw new IOException("simulated disk-full for fail-closed test");
        public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct) =>
            _inner.RecordAiConsentAsync(providerId, disclosureVersion, ct);
        public event EventHandler<PRism.Core.Config.ConfigChangedEventArgs>? Changed
        {
            add { _inner.Changed += value; }
            remove { _inner.Changed -= value; }
        }

        public void Dispose() => _inner.Dispose();
    }
}
