using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Contracts;
using PRism.Web.Middleware;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// S6 PR2 Task 2.8a regression. The [LoggerMessage] methods in AuthEndpoints.Log
// previously used bare `login` parameter names which the LoggerMessage source
// generator emitted verbatim as structured-log field keys. SensitiveFieldScrubber's
// BlockedFieldNames includes "login" (case-insensitive), so every /api/auth/connect
// happy-path log line wrote [REDACTED] in place of the validated login — a silent
// forensic gap. Renaming to validatedLogin / committedLogin moves the field keys
// outside the scrubber's blocklist while keeping the user-visible message text
// readable. Pins the fix so a future contributor can't quietly re-introduce the
// regression by reverting to `{Login}`.
public class AuthEndpointsLoggingTests
{
    private sealed class HarnessFactory : WebApplicationFactory<Program>
    {
        public PRismWebApplicationFactory Base { get; }
        public Func<Task<AuthValidationResult>>? Validate { get; set; }
        public ListLoggerProvider Logs { get; } = new();

        public HarnessFactory() { Base = new PRismWebApplicationFactory(); }

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
            builder.ConfigureServices(s =>
            {
                s.RemoveAll<IReviewAuth>();
                s.AddSingleton<IReviewAuth>(new StubReviewAuth(() =>
                    (Validate ?? (() => Task.FromResult(new AuthValidationResult(
                        Ok: true, Login: "default", Scopes: null,
                        Error: AuthValidationError.None, ErrorDetail: null))))()));
                s.AddSingleton<ILoggerProvider>(Logs);
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

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            Base.Dispose();
        }
    }

    [Fact]
    public async Task ConnectHappyPath_LogsCommittedLogin_NotRedacted()
    {
        // The structured-log keys the LoggerMessage source generator emits ARE what
        // SensitiveFieldScrubber sees in FileLogger. Capture them directly via a
        // KV-aware logger provider and assert the renamed key is present (not the
        // bare `login` that would have been scrubbed).
        var kvLogs = new KvCapturingLoggerProvider();
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "alice", Scopes: new[] { "repo" },
                Error: AuthValidationError.None, ErrorDetail: null)),
        };
        // Inject the KV provider alongside the default ListLoggerProvider.
        using var client = new HarnessFactoryWithExtraProvider(f, kvLogs).CreateClient();

        var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_x" });
        resp.IsSuccessStatusCode.Should().BeTrue();

        // Structured-args key must be the qualified name. The LoggerMessage source
        // generator emits the template token (`{CommittedLogin}`) as the key, NOT the
        // declared parameter name's exact casing. Per SensitiveFieldScrubber semantics
        // (full-key case-insensitive equality), `CommittedLogin` ≠ `login` → no
        // [REDACTED] substitution.
        kvLogs.Records.Should().Contain(r =>
            r.Keys.Contains("CommittedLogin", StringComparer.Ordinal)
            && r.GetValue("CommittedLogin") as string == "alice");
        kvLogs.Records.Should().NotContain(r => r.Keys.Contains("Login", StringComparer.OrdinalIgnoreCase),
            "bare `login` (any casing) is scrubber-blocked; AuthEndpoints must use qualified names");
    }

    [Fact]
    public async Task ConnectNoReposWarning_LogsValidatedLogin_NotRedacted()
    {
        var kvLogs = new KvCapturingLoggerProvider();
        using var f = new HarnessFactory
        {
            Validate = () => Task.FromResult(new AuthValidationResult(
                Ok: true, Login: "alice", Scopes: null,
                Error: AuthValidationError.None, ErrorDetail: null,
                Warning: AuthValidationWarning.NoReposSelected)),
        };
        using var client = new HarnessFactoryWithExtraProvider(f, kvLogs).CreateClient();

        var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_x" });
        resp.IsSuccessStatusCode.Should().BeTrue();

        kvLogs.Records.Should().Contain(r =>
            r.Keys.Contains("ValidatedLogin", StringComparer.Ordinal)
            && r.GetValue("ValidatedLogin") as string == "alice");
        kvLogs.Records.Should().NotContain(r => r.Keys.Contains("Login", StringComparer.OrdinalIgnoreCase));
    }

    // Wraps HarnessFactory with an additional KV-capturing logger provider so the
    // structured-args path can be observed alongside the formatted-message path the
    // base factory's ListLoggerProvider captures.
    private sealed class HarnessFactoryWithExtraProvider : IDisposable
    {
        private readonly HarnessFactory _f;
        private readonly KvCapturingLoggerProvider _extra;

        public HarnessFactoryWithExtraProvider(HarnessFactory f, KvCapturingLoggerProvider extra)
        {
            _f = f;
            _extra = extra;
            // Force services to spin up so the logger factory grabs both providers.
            _ = _f.Services;
            var lf = _f.Services.GetRequiredService<ILoggerFactory>();
            lf.AddProvider(_extra);
        }

        public HttpClient CreateClient() => _f.CreateClient();
        public void Dispose() { /* HarnessFactory disposes via its own using; provider disposed with factory */ }
    }
}
