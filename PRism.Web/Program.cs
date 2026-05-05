using System.Diagnostics.CodeAnalysis;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Hosting;
using PRism.Web.Endpoints;
using PRism.Web.Middleware;

var builder = WebApplication.CreateBuilder(args);

// Resolve dataDir from configuration (test sets it via UseSetting; production uses SpecialFolder).
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

// DI: ConfigStore + AiPreviewState singletons.
builder.Services.AddSingleton<IConfigStore>(_ => CreateConfigStore(dataDir));
builder.Services.AddSingleton<AiPreviewState>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var state = new AiPreviewState { IsOn = config.Current.Ui.AiPreview };
    config.Changed += (_, args) => state.IsOn = args.Config.Ui.AiPreview;
    return state;
});

var app = builder.Build();

app.UseMiddleware<RequestIdMiddleware>();
app.UseMiddleware<OriginCheckMiddleware>();

app.MapHealth(dataDir: dataDir, port: 5180);
app.MapCapabilities();
app.MapPost("/api/preferences", () => Results.Ok(new { theme = "system", accent = "indigo", aiPreview = false }));

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
