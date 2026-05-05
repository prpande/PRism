using PRism.Web.Endpoints;
using PRism.Web.Middleware;

var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

app.UseMiddleware<RequestIdMiddleware>();
app.UseMiddleware<OriginCheckMiddleware>();

app.MapHealth(dataDir: "(testdir)", port: 5180);
app.MapPost("/api/preferences", () => Results.Ok(new { theme = "system", accent = "indigo", aiPreview = false }));

app.Run();

#pragma warning disable CA1515 // WebApplicationFactory<Program> in tests requires Program to be publicly accessible.
public partial class Program { }
#pragma warning restore CA1515
