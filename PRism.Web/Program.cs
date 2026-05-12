using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using PRism.Core;
using PRism.Core.Hosting;
using PRism.GitHub;
using PRism.Web.Composition;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;
using PRism.Web.TestHooks;

var builder = WebApplication.CreateBuilder(args);

// Static Web Assets (the build manifest that maps /assets/* URLs to files
// under wwwroot) are auto-enabled only in Development. The Playwright E2E
// suite runs the host under Test env (to engage the fake-review swap
// below) and would otherwise serve every JS/CSS asset as 200 OK with 0
// bytes — the SPA never bootstraps. We gate this on the same opt-in env
// var as the fake-review swap (PRISM_E2E_FAKE_REVIEW=1) so the existing
// xUnit WebApplicationFactory suite (also Test env) keeps using its per-
// test UseWebRoot stub instead of the real wwwroot manifest.
if (builder.Environment.IsEnvironment("Test")
    && Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1")
{
    builder.WebHost.UseStaticWebAssets();
}

// Resolve dataDir from configuration (test sets it via UseSetting; production uses SpecialFolder).
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

builder.Services.AddPrismCore(dataDir);
builder.Services.AddPrismGitHub();
builder.Services.AddPrismAi();
builder.Services.AddPrismWeb();
builder.Services.AddSingleton<SessionTokenProvider>();

// Test environment: opt-in swap GitHubReviewService → the split fakes so Playwright
// can drive the backend without needing a real GitHub PAT. The swap also makes /test/*
// endpoints meaningful (they resolve FakeReviewBackingStore to mutate scenario state).
// See PRism.Web/TestHooks/FakeReviewBackingStore.cs and the four Fake*.cs fakes.
//
// Why opt-in (PRISM_E2E_FAKE_REVIEW=1) instead of just IsEnvironment("Test"):
// the existing xUnit/WebApplicationFactory test suite already uses Test env
// and assumes the real GitHubReviewService (or per-test overrides). Auto-
// swapping under Test env would silently rewire those tests. The env-var
// is set only by Playwright via playwright.config.ts.
//
// One FakeReviewBackingStore instance is shared by the four fakes (FakeReviewAuth /
// FakePrDiscovery / FakePrReader / FakeReviewSubmitter), mirroring the ADR-S5-1
// capability split on the test side.
if (builder.Environment.IsEnvironment("Test")
    && Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1")
{
    foreach (var serviceType in new[]
             {
                 typeof(IReviewAuth), typeof(IPrDiscovery), typeof(IPrReader), typeof(IReviewSubmitter),
             })
    {
        // RemoveAll (vs. removing the first match) in case any of these were registered
        // more than once upstream.
        builder.Services.RemoveAll(serviceType);
    }
    builder.Services.AddSingleton<FakeReviewBackingStore>();
    builder.Services.AddSingleton<IReviewAuth, FakeReviewAuth>();
    builder.Services.AddSingleton<IPrDiscovery, FakePrDiscovery>();
    builder.Services.AddSingleton<IPrReader, FakePrReader>();
    builder.Services.AddSingleton<IReviewSubmitter, FakeReviewSubmitter>();
}

var app = builder.Build();

// Resolve port early so MapHealth can report the actual bound port.
// In Test environment, the WebApplicationFactory uses an in-memory test server;
// the reported port is a placeholder (5180) since TestServer handles binding.
var isTest = app.Environment.IsEnvironment("Test");
var explicitUrls = builder.Configuration["urls"];
var port = isTest
    ? 5180
    : (!string.IsNullOrEmpty(explicitUrls)
        ? ExtractPort(explicitUrls)
        : PortSelector.SelectFirstAvailable());

// Production-only: lockfile + URL binding + browser launch.
if (!isTest)
{
    if (string.IsNullOrEmpty(explicitUrls))
    {
        app.Urls.Clear();
        app.Urls.Add($"http://localhost:{port}");
    }

    var binaryPath = Environment.ProcessPath ?? "PRism";
    var lockHandle = LockfileManager.Acquire(dataDir, binaryPath, Environment.ProcessId);
    app.Lifetime.ApplicationStopping.Register(() => lockHandle.Dispose());

    // Browser launch on application started, unless --no-browser was passed (case-insensitive).
    var noBrowser = args.Contains("--no-browser", StringComparer.OrdinalIgnoreCase);
    if (!noBrowser)
    {
        app.Lifetime.ApplicationStarted.Register(() =>
        {
            var launcher = new BrowserLauncher(new SystemProcessRunner(), BrowserLauncher.CurrentPlatform());
            launcher.Launch($"http://localhost:{port}");
        });
    }

    Console.WriteLine($"PRism listening on http://localhost:{port} (dataDir: {dataDir})");
}

app.UseMiddleware<RequestIdMiddleware>();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseMiddleware<OriginCheckMiddleware>();
app.UseMiddleware<SessionTokenMiddleware>();

// Body-size cap for POST /api/events/subscriptions (spec § 8 + plan Step 5.10b: 16 KiB).
// Spec § 8 names four mutating endpoints with body caps; only this one is wired up in
// PR5 because PR4's mark-viewed/files/viewed routes pre-date this branch and haven't
// been migrated yet (recorded in plan deferrals — extend to PR4 endpoints in a follow-up).
// DELETE /api/events/subscriptions has no body so no cap is needed.
//
// Registered as middleware (NOT as an IEndpointFilter on the route) because endpoint
// filters in minimal APIs run AFTER parameter binding — by the time the filter runs,
// the JSON body has already been read into the deserializer and IHttpMaxRequestBodySizeFeature
// is read-only. Placing the cap as middleware before routing means MaxRequestBodySize
// is set before the body is read, AND a Content-Length pre-check rejects oversized
// honest clients without buffering. Chunked/no-Content-Length attackers fall through
// to the framework-native MaxRequestBodySize cap (Kestrel honors it; TestServer doesn't,
// but the Content-Length pre-check is the unit-testable defense). Adversarial
// reviewer ADV-PR5-003.
// Predicate covers the mutating endpoints with body caps: POST /api/events/subscriptions
// (S3 PR5), PUT /api/pr/{ref}/draft (S4 PR3 Task 25), POST /api/pr/{ref}/reload (S4 PR3
// Task 29), and S5 PR3's POST /api/pr/{ref}/submit + /submit/foreign-pending-review/{resume,
// discard} + /drafts/discard-all (spec § 7.1 / § 13.2). The submit-family bodies are one-field
// discriminators / empty, so they inherit the existing 16 KiB cap rather than getting a separate
// primitive — the unified branch keeps the cap defense single-sited. These are all leaf segments
// under /api/pr/{owner}/{repo}/{number}/, so suffix matching is the cheapest correct check —
// none of owner / repo / number can produce a path ending in one of these.
app.UseWhen(
    static ctx =>
    {
        var path = ctx.Request.Path;
        var method = ctx.Request.Method;
        if (HttpMethods.IsPost(method) && path.StartsWithSegments("/api/events/subscriptions", StringComparison.Ordinal))
            return true;
        if (!path.StartsWithSegments("/api/pr", StringComparison.Ordinal)) return false;
        var value = path.Value!;
        if (HttpMethods.IsPut(method) && value.EndsWith("/draft", StringComparison.Ordinal)) return true;
        if (!HttpMethods.IsPost(method)) return false;
        return value.EndsWith("/reload", StringComparison.Ordinal)
            || value.EndsWith("/submit", StringComparison.Ordinal)
            || value.EndsWith("/submit/foreign-pending-review/resume", StringComparison.Ordinal)
            || value.EndsWith("/submit/foreign-pending-review/discard", StringComparison.Ordinal)
            || value.EndsWith("/drafts/discard-all", StringComparison.Ordinal);
    },
    branch => branch.Use(async (ctx, next) =>
    {
        const long Cap = 16 * 1024;
        var feat = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
        if (feat is not null && !feat.IsReadOnly) feat.MaxRequestBodySize = Cap;
        if (ctx.Request.ContentLength is { } cl && cl > Cap)
        {
            ctx.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return;
        }
        await next().ConfigureAwait(false);
    }));

// Stamp the prism-session cookie on every text/html response (the SPA's index.html
// load path) so the SPA can read it and echo as X-PRism-Session on subsequent
// fetches. Response.OnStarting fires before the first body byte writes, which
// works with static-file + minimal-API + fallback-to-file paths alike. Predicate
// excludes SSE responses (text/event-stream) so EventSource doesn't get the cookie
// twice — it already arrived with the HTML page.
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        if (ctx.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true)
        {
            var token = ctx.RequestServices.GetRequiredService<SessionTokenProvider>().Current;
            ctx.Response.Cookies.Append("prism-session", token, new CookieOptions
            {
                HttpOnly = false,
                SameSite = SameSiteMode.Strict,
                Secure = false,
                Path = "/",
            });
        }
        return Task.CompletedTask;
    });
    await next().ConfigureAwait(false);
});

app.MapStaticAssets();

app.MapHealth(dataDir: dataDir, port: port);
app.MapCapabilities();
app.MapPreferences();
app.MapAuth();
app.MapEvents();
app.MapInbox();
app.MapPrDetail();
app.MapPrDraftEndpoints();
app.MapPrReloadEndpoints();
app.MapPrSubmitEndpoints();
app.MapPrDraftsDiscardAllEndpoint();
app.MapAi();

if (builder.Environment.IsEnvironment("Test"))
    app.MapGet("/test/boom", () => { throw new InvalidOperationException("test boom"); });

// /test/advance-head + /test/set-commit-reachable for Playwright fixture mutation.
// Method itself env-guards at registration; the call here keeps Program.cs symmetric
// with the other endpoint map* calls.
app.MapTestEndpoints();

// Unknown /api/* paths return 404 (more specific pattern wins over the SPA fallback).
app.MapFallback("/api/{*rest}", () => Microsoft.AspNetCore.Http.Results.NotFound());

// SPA fallback: every other unmatched route serves the React app's index.html so client-side
// routing works.
app.MapFallbackToFile("index.html");

app.Run();

// Parse a port out of an --urls value (first URL when ;/, separated). Falls back to 5180.
static int ExtractPort(string urls)
{
    var first = urls.Split(';', ',')[0].Trim();
    if (Uri.TryCreate(first, UriKind.Absolute, out var u)) return u.Port;
    return 5180;
}

#pragma warning disable CA1515 // WebApplicationFactory<Program> in tests requires Program to be publicly accessible.
public partial class Program { }
#pragma warning restore CA1515
