using Microsoft.Extensions.Hosting;
using PRism.Core;
using PRism.Core.Hosting;
using PRism.GitHub;
using PRism.Web.Composition;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;

var builder = WebApplication.CreateBuilder(args);

// Resolve dataDir from configuration (test sets it via UseSetting; production uses SpecialFolder).
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

builder.Services.AddPrismCore(dataDir);
builder.Services.AddPrismGitHub();
builder.Services.AddPrismAi();
builder.Services.AddPrismWeb();

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

app.MapStaticAssets();

app.MapHealth(dataDir: dataDir, port: port);
app.MapCapabilities();
app.MapPreferences();
app.MapAuth();
app.MapEvents();
app.MapInbox();
app.MapPrDetail();

if (builder.Environment.IsEnvironment("Test"))
    app.MapGet("/test/boom", () => { throw new InvalidOperationException("test boom"); });

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
