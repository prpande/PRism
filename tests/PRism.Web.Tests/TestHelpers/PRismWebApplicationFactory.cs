using System.IO;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Web.Middleware;

namespace PRism.Web.Tests.TestHelpers;

public sealed class PRismWebApplicationFactory : WebApplicationFactory<Program>
{
    public string DataDir { get; } = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
    public Func<Task<AuthValidationResult>>? ValidateOverride { get; set; }
    public FakeInboxRefreshOrchestrator? FakeOrchestrator { get; set; }

    // When set, this fake replaces the GitHubReviewService binding for all four
    // capability interfaces (ADR-S5-1) — used by PR-detail endpoint tests.
    public PrDetailFakeReviewService? ReviewServiceOverride { get; set; }

    // Lazily resolved per-process session token (the SessionTokenMiddleware checks
    // X-PRism-Session header / prism-session cookie against this value). Tests that
    // need to assert against the token (e.g. cookie integration) use this property.
    public string SessionToken => Services.GetRequiredService<SessionTokenProvider>().Current;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        Directory.CreateDirectory(DataDir);

        // Provide a deterministic wwwroot/index.html so MapFallbackToFile("index.html")
        // can serve SPA routes during tests, regardless of whether the frontend bundle
        // has been built. The stub marker lets tests prove the fallback path served the
        // response. DataDir is deleted recursively in Dispose, so wwwroot/ goes with it.
        var webRoot = Path.Combine(DataDir, "wwwroot");
        Directory.CreateDirectory(webRoot);
        File.WriteAllText(
            Path.Combine(webRoot, "index.html"),
            "<!DOCTYPE html><html><body>PRism test stub</body></html>");
        builder.UseWebRoot(webRoot);

        builder.UseSetting("DataDir", DataDir);
        builder.UseEnvironment("Test");

        builder.ConfigureServices(services =>
        {
            // Replace the GitHubReviewService capability bindings with a fully-scripted fake
            // when ReviewServiceOverride is set (PR-detail tests). Falls through to the
            // validate-only stub branch (IReviewAuth alone) when ValidateOverride is set
            // instead. ReviewServiceOverride takes precedence.
            if (ReviewServiceOverride is not null)
            {
                ReplaceSingleton<IReviewAuth>(services, ReviewServiceOverride);
                ReplaceSingleton<IPrDiscovery>(services, ReviewServiceOverride);
                ReplaceSingleton<IPrReader>(services, ReviewServiceOverride);
                ReplaceSingleton<IReviewSubmitter>(services, ReviewServiceOverride);
            }
            else if (ValidateOverride is not null)
            {
                ReplaceSingleton<IReviewAuth>(services, new StubReviewService(ValidateOverride));
            }

            // Replace IInboxRefreshOrchestrator with a fake when FakeOrchestrator is set.
            if (FakeOrchestrator is not null)
            {
                ReplaceSingleton<IInboxRefreshOrchestrator>(services, FakeOrchestrator);
            }
        });
    }

    // Removes any existing registration for TService and registers the supplied instance
    // as a singleton in its place. The WebApplicationFactory layer runs after Program.cs's
    // AddPrism* calls, so the production registration is always present to remove first.
    private static void ReplaceSingleton<TService>(IServiceCollection services, TService instance)
        where TService : class
    {
        var existing = services.FirstOrDefault(d => d.ServiceType == typeof(TService));
        if (existing is not null) services.Remove(existing);
        services.AddSingleton(instance);
    }

    // Default test client carries auto-injected session-token credentials AND a
    // same-origin Origin header so existing tests don't have to know about the
    // SessionTokenMiddleware or the post-S3 OriginCheckMiddleware tightening (which
    // rejects empty Origin on POST/PUT/PATCH/DELETE). Tests asserting 401 / 403
    // paths use CreateUnauthenticatedClient instead, and OriginCheckMiddlewareTests
    // remove the default Origin before setting their own per-test value.
    protected override void ConfigureClient(System.Net.Http.HttpClient client)
    {
        ArgumentNullException.ThrowIfNull(client);
        base.ConfigureClient(client);
        var token = SessionToken;
        client.DefaultRequestHeaders.Add("X-PRism-Session", token);
        client.DefaultRequestHeaders.Add("Cookie", $"prism-session={token}");
        var sameOrigin = client.BaseAddress?.GetLeftPart(UriPartial.Authority);
        if (!string.IsNullOrEmpty(sameOrigin))
            client.DefaultRequestHeaders.Add("Origin", sameOrigin);
    }

    // For tests that need to exercise the 401 path (no token / wrong token). Uses
    // Server.CreateClient() directly so ConfigureClient (which auto-injects auth) is
    // bypassed — CreateDefaultClient ALSO runs ConfigureClient, so it can't be used.
    public System.Net.Http.HttpClient CreateUnauthenticatedClient()
    {
        var client = Server.CreateClient();
        client.BaseAddress = ClientOptions.BaseAddress;
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { if (Directory.Exists(DataDir)) Directory.Delete(DataDir, recursive: true); }
#pragma warning disable CA1031 // best-effort cleanup of temp dir
        catch { }
#pragma warning restore CA1031
    }
}

// Auth-only stub. Wired in by PRismWebApplicationFactory.ValidateOverride for /api/auth/*
// tests; only ValidateCredentialsAsync is meaningful. The other capability interfaces stay
// bound to GitHubReviewService (never resolved in these tests).
internal sealed class StubReviewService : IReviewAuth
{
    private readonly Func<Task<AuthValidationResult>> _validate;
    public StubReviewService(Func<Task<AuthValidationResult>> validate) { _validate = validate; }

    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) => _validate();
}
