using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Hosting;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core;
using PRism.Core.Ai;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Events;
using PRism.Core.Hosting;
using PRism.Core.Inbox;
using PRism.Core.Json;
using PRism.Core.State;
using PRism.GitHub;
using PRism.GitHub.Inbox;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;
using PRism.Web.Sse;

var builder = WebApplication.CreateBuilder(args);

// Resolve dataDir from configuration (test sets it via UseSetting; production uses SpecialFolder).
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

// Named "github" HttpClient — configured with the GitHub API base address.
// All GitHub components retrieve a fresh wrapper (pooled handler) via IHttpClientFactory.
builder.Services.AddHttpClient("github", (sp, client) =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    client.BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host);
});

// DI: ConfigStore + AiPreviewState + AppStateStore + TokenStore + ReviewService singletons.
builder.Services.AddSingleton<IConfigStore>(_ => CreateConfigStore(dataDir));
builder.Services.AddSingleton<AiPreviewState>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var state = new AiPreviewState { IsOn = config.Current.Ui.AiPreview };
    config.Changed += (_, args) => state.IsOn = args.Config.Ui.AiPreview;
    return state;
});
builder.Services.AddSingleton<IAppStateStore>(_ => new AppStateStore(dataDir));
builder.Services.AddSingleton<ITokenStore>(_ => new TokenStore(dataDir));
builder.Services.AddSingleton<IReviewService>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubReviewService(factory, () => tokens.ReadAsync(CancellationToken.None), config.Current.Github.Host);
});

// AI seams: register both Noop and Placeholder, plus the selector.
builder.Services.AddSingleton<NoopPrSummarizer>();
builder.Services.AddSingleton<NoopFileFocusRanker>();
builder.Services.AddSingleton<NoopHunkAnnotator>();
builder.Services.AddSingleton<NoopPreSubmitValidator>();
builder.Services.AddSingleton<NoopComposerAssistant>();
builder.Services.AddSingleton<NoopDraftSuggester>();
builder.Services.AddSingleton<NoopDraftReconciliator>();
builder.Services.AddSingleton<NoopInboxItemEnricher>();
builder.Services.AddSingleton<NoopInboxRanker>();

builder.Services.AddSingleton<PlaceholderPrSummarizer>();
builder.Services.AddSingleton<PlaceholderFileFocusRanker>();
builder.Services.AddSingleton<PlaceholderHunkAnnotator>();
builder.Services.AddSingleton<PlaceholderPreSubmitValidator>();
builder.Services.AddSingleton<PlaceholderComposerAssistant>();
builder.Services.AddSingleton<PlaceholderDraftSuggester>();
builder.Services.AddSingleton<PlaceholderDraftReconciliator>();
builder.Services.AddSingleton<PlaceholderInboxItemEnricher>();
builder.Services.AddSingleton<PlaceholderInboxRanker>();

builder.Services.AddSingleton<IAiSeamSelector>(sp => new AiSeamSelector(
    sp.GetRequiredService<AiPreviewState>(),
    new Dictionary<Type, object>
    {
        [typeof(IPrSummarizer)] = sp.GetRequiredService<NoopPrSummarizer>(),
        [typeof(IFileFocusRanker)] = sp.GetRequiredService<NoopFileFocusRanker>(),
        [typeof(IHunkAnnotator)] = sp.GetRequiredService<NoopHunkAnnotator>(),
        [typeof(IPreSubmitValidator)] = sp.GetRequiredService<NoopPreSubmitValidator>(),
        [typeof(IComposerAssistant)] = sp.GetRequiredService<NoopComposerAssistant>(),
        [typeof(IDraftSuggester)] = sp.GetRequiredService<NoopDraftSuggester>(),
        [typeof(IDraftReconciliator)] = sp.GetRequiredService<NoopDraftReconciliator>(),
        [typeof(IInboxItemEnricher)] = sp.GetRequiredService<NoopInboxItemEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<NoopInboxRanker>(),
    },
    new Dictionary<Type, object>
    {
        [typeof(IPrSummarizer)] = sp.GetRequiredService<PlaceholderPrSummarizer>(),
        [typeof(IFileFocusRanker)] = sp.GetRequiredService<PlaceholderFileFocusRanker>(),
        [typeof(IHunkAnnotator)] = sp.GetRequiredService<PlaceholderHunkAnnotator>(),
        [typeof(IPreSubmitValidator)] = sp.GetRequiredService<PlaceholderPreSubmitValidator>(),
        [typeof(IComposerAssistant)] = sp.GetRequiredService<PlaceholderComposerAssistant>(),
        [typeof(IDraftSuggester)] = sp.GetRequiredService<PlaceholderDraftSuggester>(),
        [typeof(IDraftReconciliator)] = sp.GetRequiredService<PlaceholderDraftReconciliator>(),
        [typeof(IInboxItemEnricher)] = sp.GetRequiredService<PlaceholderInboxItemEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<PlaceholderInboxRanker>(),
    }));

// SSE: event bus, subscriber counter, and SSE channel (Phase 9).
builder.Services.AddSingleton<IReviewEventBus, ReviewEventBus>();
builder.Services.AddSingleton<InboxSubscriberCount>();
builder.Services.AddSingleton<SseChannel>();

// Phase 10 minimal DI — Phase 11 expands to the full pipeline.
builder.Services.AddSingleton<IInboxDeduplicator, InboxDeduplicator>();

builder.Services.AddSingleton<ISectionQueryRunner>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubSectionQueryRunner(factory, () => tokens.ReadAsync(CancellationToken.None));
});

builder.Services.AddSingleton<IPrEnricher>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubPrEnricher(factory, () => tokens.ReadAsync(CancellationToken.None));
});

builder.Services.AddSingleton<IAwaitingAuthorFilter>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubAwaitingAuthorFilter(factory, () => tokens.ReadAsync(CancellationToken.None));
});

builder.Services.AddSingleton<ICiFailingDetector>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubCiFailingDetector(factory, () => tokens.ReadAsync(CancellationToken.None));
});

builder.Services.AddSingleton<IViewerLoginProvider, ViewerLoginProvider>();

builder.Services.AddSingleton<IInboxRefreshOrchestrator>(sp =>
{
    var loginCache = sp.GetRequiredService<IViewerLoginProvider>();
    return new InboxRefreshOrchestrator(
        sp.GetRequiredService<IConfigStore>(),
        sp.GetRequiredService<ISectionQueryRunner>(),
        sp.GetRequiredService<IPrEnricher>(),
        sp.GetRequiredService<IAwaitingAuthorFilter>(),
        sp.GetRequiredService<ICiFailingDetector>(),
        sp.GetRequiredService<IInboxDeduplicator>(),
        sp.GetRequiredService<IAiSeamSelector>(),
        sp.GetRequiredService<IReviewEventBus>(),
        sp.GetRequiredService<IAppStateStore>(),
        loginCache.Get);
});

// Hydrate the viewer-login cache from a previously stored token before the inbox poller
// starts. IHostedService.StartAsync runs in registration order, so this MUST be added before
// AddHostedService<InboxPoller> below — otherwise the first refresh tick after a restart sees
// an empty viewer login and the awaiting-author section silently returns no PRs until the user
// re-runs /api/auth/connect.
builder.Services.AddHostedService<ViewerLoginHydrator>(sp =>
    new ViewerLoginHydrator(
        sp.GetRequiredService<ITokenStore>(),
        sp.GetRequiredService<IReviewService>(),
        sp.GetRequiredService<IViewerLoginProvider>(),
        sp.GetRequiredService<ILogger<ViewerLoginHydrator>>()));

builder.Services.AddHostedService<InboxPoller>(sp =>
    new InboxPoller(
        sp.GetRequiredService<IInboxRefreshOrchestrator>(),
        sp.GetRequiredService<InboxSubscriberCount>(),
        sp.GetRequiredService<IConfigStore>(),
        sp.GetRequiredService<ILogger<InboxPoller>>()));

// JSON options: align HTTP serialization with the camelCase Api policy.
builder.Services.ConfigureHttpJsonOptions(o =>
{
    var api = JsonSerializerOptionsFactory.Api;
    o.SerializerOptions.PropertyNamingPolicy = api.PropertyNamingPolicy;
    o.SerializerOptions.DictionaryKeyPolicy = api.DictionaryKeyPolicy;
    foreach (var c in api.Converters) o.SerializerOptions.Converters.Add(c);
});

builder.Services.AddProblemDetails(o =>
{
    o.CustomizeProblemDetails = ctx =>
    {
        var requestId = ctx.HttpContext.Items["RequestId"] as string;
        if (!string.IsNullOrEmpty(requestId))
            ctx.ProblemDetails.Extensions["traceId"] = requestId;
    };
});

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

if (builder.Environment.IsEnvironment("Test"))
    app.MapGet("/test/boom", () => { throw new InvalidOperationException("test boom"); });

// Unknown /api/* paths return 404 (more specific pattern wins over the SPA fallback).
app.MapFallback("/api/{*rest}", () => Microsoft.AspNetCore.Http.Results.NotFound());

// SPA fallback: every other unmatched route serves the React app's index.html so client-side
// routing works.
app.MapFallbackToFile("index.html");

app.Run();

[SuppressMessage("Performance", "CA1849:Call async methods when in an async method",
    Justification = "DI factory delegates are synchronous; ConfigStore.InitAsync is awaited via GetAwaiter().GetResult() at host startup, which is the documented pattern for one-time async initialization inside a sync DI factory.")]
static IConfigStore CreateConfigStore(string dataDir)
{
    var store = new ConfigStore(dataDir);
    store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
    return store;
}

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
