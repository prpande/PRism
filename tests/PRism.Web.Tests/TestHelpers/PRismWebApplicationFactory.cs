using System.IO;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace PRism.Web.Tests.TestHelpers;

public sealed class PRismWebApplicationFactory : WebApplicationFactory<Program>
{
    public string DataDir { get; } = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        Directory.CreateDirectory(DataDir);
        builder.UseSetting("DataDir", DataDir);
        builder.UseEnvironment("Test");
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
