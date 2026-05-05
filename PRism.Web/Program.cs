using System.Diagnostics.CodeAnalysis;
using PRism.Core;
using PRism.Core.Ai;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Hosting;
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

app.UseMiddleware<RequestIdMiddleware>();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseMiddleware<OriginCheckMiddleware>();

app.MapHealth(dataDir: dataDir, port: 5180);
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
