using System.IO;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PRism.Web.Logging;

internal static class FileLoggerExtensions
{
    // Registers the FileLoggerProvider as an additional ILoggerProvider alongside the
    // framework defaults (Console + Debug). Gated on !env.IsEnvironment("Test") so xUnit
    // WebApplicationFactory<Program>-based tests don't all spin up writer tasks against
    // 111 temp DataDirs (see spec § 9.1). Integration tests in
    // tests/PRism.Web.Tests/Logging/FileLoggerIntegrationTests.cs opt in explicitly via
    // factory.WithWebHostBuilder(...) with a per-test Guid-named temp DataDir.
    //
    // The Test-env gate is bypassed when PRISM_FILE_LOGGER_FORCE=1 is set in the
    // environment. This lets the real-flow Playwright suite (which sets
    // ASPNETCORE_ENVIRONMENT=Test for cadence and seam reasons) opt into on-disk
    // logging for the stale-OID investigation methodology — see
    // docs/specs/2026-05-19-stale-oid-banner-investigation-design.md Section 3.4.
    //
    // The pre-Build registration shape (call from Program.cs BEFORE builder.Build()) is
    // load-bearing: LoggerFactory.AddProvider called AFTER Build() does not propagate to
    // already-resolved Logger<T> instances, and LoggerFactory.Dispose invokes sync
    // Dispose() not DisposeAsync(), breaking the drain contract. See spec § 9.
    public static ILoggingBuilder AddPRismFileLogger(this ILoggingBuilder builder, string dataDir, IHostEnvironment env)
    {
        if (env.IsEnvironment("Test")
            && Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE") != "1")
            return builder;

        var logsDir = Path.Combine(dataDir, "logs");
        builder.Services.AddSingleton<FileLoggerProvider>(_ => new FileLoggerProvider(logsDir));
        builder.Services.AddSingleton<ILoggerProvider>(sp => sp.GetRequiredService<FileLoggerProvider>());
        return builder;
    }
}
