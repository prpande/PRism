using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using PRism.Core;
using PRism.Core.Hosting;
using PRism.GitHub;
using PRism.Web.Composition;
using PRism.Web.Endpoints;
using PRism.Web.Hosting;
using PRism.Web.Logging;
using PRism.Web.Middleware;
using PRism.Web.TestHooks;

var builder = WebApplication.CreateBuilder(args);

// Static Web Assets (the build manifest that maps /assets/* URLs to files
// under wwwroot) are auto-enabled only in Development. The Playwright E2E
// suite runs the host under Test env (to engage the fake-review swap
// below, or the real-inject seam) and would otherwise serve every JS/CSS
// asset as 200 OK with 0 bytes — the SPA never bootstraps. We gate this
// on EITHER opt-in env var (PRISM_E2E_FAKE_REVIEW=1 or PRISM_E2E_REAL_INJECT=1)
// so the existing xUnit WebApplicationFactory suite (also Test env) keeps
// using its per-test UseWebRoot stub instead of the real wwwroot manifest.
if (builder.Environment.IsEnvironment("Test")
    && (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
     || Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1"))
{
    builder.WebHost.UseStaticWebAssets();
}

// FAKE_REVIEW and REAL_INJECT are mutually exclusive — fake backend with injection
// would intercept calls that never reach GitHub, producing confusing behavior.
if (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    throw new InvalidOperationException(
      "PRISM_E2E_FAKE_REVIEW and PRISM_E2E_REAL_INJECT are mutually exclusive — " +
      "injection only makes sense against the real GitHub backend.");
}

// Resolve dataDir. Parse --dataDir directly from argv FIRST so the override survives
// regardless of flag order: the .NET command-line configuration provider treats the
// sidecar's bare "--no-browser" as a key that swallows the following "--dataDir" token,
// leaving Configuration["DataDir"] null (see CommandLineOptions). Fall back to
// configuration (tests set DataDir via UseSetting) then the OS-resolved default.
var dataDir = CommandLineOptions.GetValue(args, "--dataDir")
    ?? builder.Configuration["DataDir"]
    ?? DataDirectoryResolver.Resolve();

// Register LogsPathInfo BEFORE AddPRismFileLogger so the dual derivation lives in one
// place (Program.cs) and the GET /api/preferences handler can read it without taking
// a hard dependency on FileLoggerProvider — which intentionally doesn't register under
// the default Test env (FileLoggerExtensions.cs gates it on env != "Test" unless
// PRISM_FILE_LOGGER_FORCE=1). Dual-derivation invariant is test-pinned by
// PreferencesLogsPathDualDerivationTests. Spec § 2.4 + S6 deferrals.
builder.Services.AddSingleton(new PRism.Web.Logging.LogsPathInfo(Path.Combine(dataDir, "logs")));

builder.Logging.AddPRismFileLogger(dataDir, builder.Environment);

// Persist tokens to an unprotected file (not the OS keyring) ONLY in the e2e
// Test backend — the headless Linux container has no D-Bus/X11 for MSAL's
// keyring. Gated on Test env AND a PRISM_E2E_* var (mirrors the
// UseStaticWebAssets gate above), so an accidental PRISM_E2E_* var in a
// non-Test environment can never downgrade token protection.
var useUnprotectedTokenCache =
    builder.Environment.IsEnvironment("Test")
    && (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
     || Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1");
builder.Services.AddPrismCore(dataDir, useUnprotectedTokenCache);
builder.Services.AddPrismGitHub();
builder.Services.AddPrismAi();
builder.Services.AddPrismWeb();
builder.Services.AddSingleton<SessionTokenProvider>();
// TimeProvider is an ActivityProvider ctor dependency (clock for cache TTL + the
// notifications "since" window). Not registered elsewhere, so register the system
// clock here; a missing registration would throw "Unable to resolve service" at
// startup when the generic IActivityProvider registration below is built.
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<PRism.Core.Activity.IActivityProvider, PRism.Core.Activity.ActivityProvider>();

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
                 typeof(PRism.Core.Inbox.ISectionQueryRunner), typeof(PRism.Core.Inbox.IPrEnricher), typeof(PRism.Core.Inbox.ICiFailingDetector),
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
    builder.Services.AddSingleton<PRism.Core.Inbox.ISectionQueryRunner, FakeSectionQueryRunner>();
    builder.Services.AddSingleton<PRism.Core.Inbox.IPrEnricher, FakePrEnricher>();
    builder.Services.AddSingleton<PRism.Core.Inbox.ICiFailingDetector, FakeCiFailingDetector>();
    builder.Services.RemoveAll<PRism.Core.Activity.IActivityProvider>();
    builder.Services.AddSingleton<PRism.Core.Activity.IActivityProvider, PRism.Web.TestHooks.FakeActivityProvider>();
}

// Test env + REAL_INJECT: attach TestFailureInjectionHandler to the "github" named HttpClient.
// MUST run after AddPrismGitHub() so the named "github" client is already configured by
// PRism.GitHub.ServiceCollectionExtensions.AddPrismGitHub; this call is additive on the
// same client name (preserves BaseAddress).
if (builder.Environment.IsEnvironment("Test")
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    builder.Services.AddSingleton<RealTransportFailureInjector>();
    builder.Services.AddTransient<TestFailureInjectionHandler>();
    builder.Services.AddHttpClient("github")
        .AddHttpMessageHandler<TestFailureInjectionHandler>();
}

// Detect sidecar mode (Electron shell launch) once. Reused by the production block below.
var sidecar = SidecarMode.Detect(Environment.GetEnvironmentVariable);

// Guard: sidecar mode REQUIRES a valid parent PID. A process that thinks it's a
// sidecar (binds 127.0.0.1, suppresses browser launch) but has no parent to watch
// would orphan silently. The shell always passes PRISM_PARENT_PID; a missing/bad
// one means a hand-invocation — refuse rather than run watchdog-free.
if (sidecar.Enabled && sidecar.ParentPid is null)
{
    Console.Error.WriteLine("PRISM_SIDECAR=1 requires a valid PRISM_PARENT_PID. Refusing to start.");
    Environment.Exit(1); // non-zero: signal misconfiguration explicitly, not a clean exit
    return;
}

if (sidecar.Enabled && sidecar.ParentPid is int parentPid)
{
    var probe = ParentLivenessProbe.Arm(parentPid, ParentLivenessProbe.StartTimeOfProcess);
    if (probe is null)
    {
        // Parent already gone before we finished starting — exit immediately, don't orphan.
        return;
    }

    builder.Services.AddHostedService(sp =>
        new ParentLivenessWatchdog(
            probe,
            sp.GetRequiredService<IHostApplicationLifetime>(),
            TimeSpan.FromSeconds(2)));
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
        // Standardize the sidecar on the 127.0.0.1 literal so the renderer's Origin,
        // the Host-header check, and the bind all agree (avoids localhost/::1 drift).
        // Browser-tab mode keeps localhost for backward compatibility.
        var host = sidecar.Enabled ? "127.0.0.1" : "localhost";
        app.Urls.Add($"http://{host}:{port}");
    }

    var binaryPath = Environment.ProcessPath ?? "PRism";
    var lockHandle = LockfileManager.Acquire(dataDir, binaryPath, Environment.ProcessId);
    app.Lifetime.ApplicationStopping.Register(() => lockHandle.Dispose());

    var reportHost = sidecar.Enabled ? "127.0.0.1" : "localhost";

    // Browser launch only in browser-tab mode. The shell passes --no-browser AND
    // PRISM_SIDECAR=1; we never auto-open a browser when wrapped by Electron.
    var noBrowser = args.Contains("--no-browser", StringComparer.OrdinalIgnoreCase) || sidecar.Enabled;

    // Report the port AFTER the server binds (ApplicationStarted), not before app.Run().
    // This guarantees the shell only ever parses a port the backend actually bound —
    // a bind failure exits the process (shell's child-exit handler fails fast) instead
    // of printing a phantom port the shell would health-poll until timeout.
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        Console.WriteLine($"PRism listening on http://{reportHost}:{port} (dataDir: {dataDir})");
        if (!noBrowser)
        {
            var launcher = new BrowserLauncher(new SystemProcessRunner(), BrowserLauncher.CurrentPlatform());
            launcher.Launch($"http://localhost:{port}");
        }
    });
}

app.UseMiddleware<RequestIdMiddleware>();
app.UseExceptionHandler();
app.UseStatusCodePages();

// DNS-rebinding defense for the loopback sidecar. The threat (a rebinded page
// reaching the 127.0.0.1 socket) only exists in sidecar mode, so gate on it — NOT
// on !IsDevelopment() alone, which would 403 a reverse-proxied Host in browser-tab
// production. Runs before Origin/session checks (reject rebinding cheapest-first).
app.UseMiddleware<HostHeaderCheckMiddleware>(sidecar.Enabled && !app.Environment.IsDevelopment());

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
// Task 29), S5 PR3's POST /api/pr/{ref}/submit + /submit/foreign-pending-review/{resume,
// discard} + /drafts/discard-all (spec § 7.1 / § 13.2), and the new T10/T11 endpoints
// POST /api/pr/{ref}/root-comment/post + /submit/discard. The submit-family bodies are
// one-field discriminators / empty, so they inherit the existing 16 KiB cap rather than
// getting a separate primitive — the unified branch keeps the cap defense single-sited.
// These are all leaf segments under /api/pr/{owner}/{repo}/{number}/, so suffix matching
// is the cheapest correct check — none of owner / repo / number can produce a path ending
// in one of these.
app.UseWhen(
    static ctx =>
    {
        var path = ctx.Request.Path;
        var method = ctx.Request.Method;
        if (HttpMethods.IsPost(method) && path.StartsWithSegments("/api/events/subscriptions", StringComparison.Ordinal))
            return true;
        // S6 PR2 — POST /api/auth/replace consumes a ~40-char PAT; cap at 16 KiB for
        // consistency with the other mutating endpoints (spec deferrals sidecar
        // "[Risk] POST /api/auth/replace is absent from the 16 KiB body-size-cap
        // predicate"). Legitimate payload uses ~0.25% of the cap.
        if (HttpMethods.IsPost(method) && path.StartsWithSegments("/api/auth/replace", StringComparison.Ordinal))
            return true;
        // #211 — POST /api/feedback max valid payload is <5 KiB; cap at 16 KiB (same
        // value as other POST endpoints) prevents oversized body amplification without
        // rejecting any legitimate request.
        if (HttpMethods.IsPost(method) && path.StartsWithSegments("/api/feedback", StringComparison.Ordinal))
            return true;
        // #311 — POST /api/inbox/refresh has NO request body, so it is intentionally absent
        // from this allow-list (nothing to amplify / cap). Listed here so the omission is a
        // recorded decision, not an oversight.
        if (!path.StartsWithSegments("/api/pr", StringComparison.Ordinal)) return false;
        var value = path.Value!;
        if (HttpMethods.IsPut(method) && value.EndsWith("/draft", StringComparison.Ordinal)) return true;
        if (!HttpMethods.IsPost(method)) return false;
        return value.EndsWith("/reload", StringComparison.Ordinal)
            || value.EndsWith("/submit", StringComparison.Ordinal)
            || value.EndsWith("/submit/foreign-pending-review/resume", StringComparison.Ordinal)
            || value.EndsWith("/submit/foreign-pending-review/discard", StringComparison.Ordinal)
            || value.EndsWith("/drafts/discard-all", StringComparison.Ordinal)
            || value.EndsWith("/submit/discard", StringComparison.Ordinal)
            || value.EndsWith("/root-comment/post", StringComparison.Ordinal);
    },
    branch => branch.Use(async (ctx, next) =>
    {
        const long Cap = EndpointExtensions.MutatingBodyCapBytes;
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
// fetches, AND mark that same response Cache-Control: no-store so it is never cached.
// Response.OnStarting fires before the first body byte writes, which works with
// static-file + minimal-API + fallback-to-file paths alike. Predicate excludes SSE
// responses (text/event-stream) so EventSource doesn't get the cookie twice — it
// already arrived with the HTML page.
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

            // #433: a response carrying the per-process security cookie must never be
            // cached, or Electron's persistent HTTP cache serves a stale index.html on
            // cold relaunch (no fresh Set-Cookie → stale-cookie 401). Overwrite (assign),
            // not append: OnStarting fires last, so this wins over any Cache-Control a
            // static-file handler set — route-agnostic across MapStaticAssets/MapFallbackToFile.
            // Full rationale: docs/specs/2026-06-12-coldstart-stale-cookie-design.md.
            ctx.Response.Headers.CacheControl = "no-store";
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
app.MapActivity();
app.MapPrDetail();
app.MapPrDraftEndpoints();
app.MapPrReloadEndpoints();
app.MapPrRefreshEndpoints();
app.MapPrSubmitEndpoints();
app.MapPrRootCommentEndpoints();
app.MapPrCommentEndpoints();
app.MapSubmitInFlight();
app.MapPrDraftsDiscardAllEndpoint();
app.MapAi();
app.MapFeedback();

if (builder.Environment.IsEnvironment("Test"))
    app.MapGet("/test/boom", () => { throw new InvalidOperationException("test boom"); });

// /test/advance-head + /test/set-commit-reachable for Playwright fixture mutation.
// Method itself env-guards at registration; the call here keeps Program.cs symmetric
// with the other endpoint map* calls.
app.MapTestEndpoints();
app.MapRealInjectEndpoints();   // self-gates on Test env + REAL_INJECT

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
