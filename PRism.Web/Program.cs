using PRism.Web.Middleware;

var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

app.UseMiddleware<RequestIdMiddleware>();

app.MapGet("/api/health", () => new { status = "ok" });

app.Run();

#pragma warning disable CA1515 // WebApplicationFactory<Program> in tests requires Program to be publicly accessible.
public partial class Program { }
#pragma warning restore CA1515
