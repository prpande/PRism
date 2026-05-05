using System.Diagnostics.CodeAnalysis;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core;
using PRism.Core.Ai;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Hosting;
using PRism.Core.Json;
using PRism.Core.State;
using PRism.GitHub;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;

var builder = WebApplication.CreateBuilder(args);

// Resolve dataDir from configuration (test sets it via UseSetting; production uses SpecialFolder).
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

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
#pragma warning disable CA2000 // HttpClient is owned by the singleton IReviewService for app lifetime.
    var http = new HttpClient { BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host) };
#pragma warning restore CA2000
    return new GitHubReviewService(http, () => tokens.ReadAsync(CancellationToken.None), config.Current.Github.Host);
});

// AI seams: register both Noop and Placeholder, plus the selector.
builder.Services.AddSingleton<NoopPrSummarizer>();
builder.Services.AddSingleton<NoopFileFocusRanker>();
builder.Services.AddSingleton<NoopHunkAnnotator>();
builder.Services.AddSingleton<NoopPreSubmitValidator>();
builder.Services.AddSingleton<NoopComposerAssistant>();
builder.Services.AddSingleton<NoopDraftSuggester>();
builder.Services.AddSingleton<NoopDraftReconciliator>();
builder.Services.AddSingleton<NoopInboxEnricher>();
builder.Services.AddSingleton<NoopInboxRanker>();

builder.Services.AddSingleton<PlaceholderPrSummarizer>();
builder.Services.AddSingleton<PlaceholderFileFocusRanker>();
builder.Services.AddSingleton<PlaceholderHunkAnnotator>();
builder.Services.AddSingleton<PlaceholderPreSubmitValidator>();
builder.Services.AddSingleton<PlaceholderComposerAssistant>();
builder.Services.AddSingleton<PlaceholderDraftSuggester>();
builder.Services.AddSingleton<PlaceholderDraftReconciliator>();
builder.Services.AddSingleton<PlaceholderInboxEnricher>();
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
        [typeof(IInboxEnricher)] = sp.GetRequiredService<NoopInboxEnricher>(),
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
        [typeof(IInboxEnricher)] = sp.GetRequiredService<PlaceholderInboxEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<PlaceholderInboxRanker>(),
    }));

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
var port = isTest ? 5180 : PortSelector.SelectFirstAvailable();

// Production-only: lockfile + URL binding + browser launch.
if (!isTest)
{
    app.Urls.Clear();
    app.Urls.Add($"http://localhost:{port}");

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

app.MapHealth(dataDir: dataDir, port: port);
app.MapCapabilities();
app.MapPreferences();
app.MapAuth();

if (builder.Environment.IsEnvironment("Test"))
    app.MapGet("/test/boom", () => { throw new InvalidOperationException("test boom"); });

app.Run();

[SuppressMessage("Performance", "CA1849:Call async methods when in an async method",
    Justification = "DI factory delegates are synchronous; ConfigStore.InitAsync is awaited via GetAwaiter().GetResult() at host startup, which is the documented pattern for one-time async initialization inside a sync DI factory.")]
static IConfigStore CreateConfigStore(string dataDir)
{
    var store = new ConfigStore(dataDir);
    store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
    return store;
}

#pragma warning disable CA1515 // WebApplicationFactory<Program> in tests requires Program to be publicly accessible.
public partial class Program { }
#pragma warning restore CA1515
