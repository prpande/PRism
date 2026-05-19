using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Web.Logging;
using PRism.Web.Tests.TestHelpers;

// These tests exercise the file logger via the standard LoggerExtensions API
// (LogError / LogInformation) because the whole point is to validate behavior
// when callers use the framework's normal logging surface. LoggerMessage.Define
// would defeat that. Suppress LoggerExtensions-related analyzers file-scoped to
// stay parallel with FileLoggerProviderTests:
//   CA1848 — use LoggerMessage delegates instead of LoggerExtensions
//   CA1727 — use PascalCase named placeholders (tests intentionally use
//            lowercase `pat` to mirror the real scrub field name)
//   CA1873 — lazy evaluation of expensive logging args (synthetic test values)
#pragma warning disable CA1848, CA1727, CA1873

namespace PRism.Web.Tests.Logging;

// Sealed + GC.SuppressFinalize in Dispose to satisfy CA1063/CA1816 in line with
// the pattern established by FileLoggerProviderTests.
//
// Pinned to the EnvVarSensitive collection (DisableParallelization = true) so
// that a concurrently-running FileLoggerGateOverrideTests.T_INV_7b (which sets
// PRISM_FILE_LOGGER_FORCE=1) cannot cause AddPRismFileLogger to register a
// second FileLoggerProvider inside this class's factory.
[Collection("EnvVarSensitive")]
public sealed class FileLoggerIntegrationTests : IDisposable
{
    private readonly string _dataDir;
    private readonly string _logsDir;

    public FileLoggerIntegrationTests()
    {
        _dataDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        _logsDir = Path.Combine(_dataDir, "logs");
        Directory.CreateDirectory(_dataDir);
    }

    public void Dispose()
    {
#pragma warning disable CA1031 // Best-effort temp-dir cleanup in test teardown.
        try { if (Directory.Exists(_dataDir)) Directory.Delete(_dataDir, recursive: true); }
        catch (Exception) { /* best-effort cleanup */ }
#pragma warning restore CA1031
        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task EndToEnd_structured_log_with_pat_field_produces_file_with_redacted_value()
    {
        // Capture the daily-file path BEFORE any provider work to avoid the midnight-boundary
        // flake (provider writes pre-rollover, assertion reads post-rollover).
        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");

        // Scope the factory in an `await using` block (no explicit DisposeAsync inside the
        // block — that pattern double-disposes when the scope ends). Implicit dispose at the
        // close brace drains the writer task before assertions run.
        await using (var factory = new PRismWebApplicationFactory()
            .WithWebHostBuilder(b => b.ConfigureServices(s =>
            {
                s.AddSingleton<FileLoggerProvider>(_ => new FileLoggerProvider(_logsDir));
                s.AddSingleton<ILoggerProvider>(sp => sp.GetRequiredService<FileLoggerProvider>());
            })))
        {
            // CreateClient forces host startup so the FileLoggerProvider is wired into the
            // Logger<T>'s MessageLogger[]. The client itself is not exercised.
            using var client = factory.CreateClient();

            var loggerFactory = factory.Services.GetRequiredService<ILoggerFactory>();
            var logger = loggerFactory.CreateLogger("PRism.IntegrationTest");
            logger.LogError("auth failed with {pat}", "ghp_secret_test_xxxxxxxxxxxxxxxx");
        }

        // Now read the on-disk file.
        File.Exists(todayPath).Should().BeTrue($"the daily log file should exist at {todayPath}");

        var content = File.ReadAllText(todayPath);

        content.Should().NotContain("ghp_secret_test", "the literal PAT value must not appear on disk");
        content.Should().Contain("[REDACTED]", "the scrubber must replace the PAT");
        content.Should().Contain("auth failed with [REDACTED]", "the formatted line should have the scrubbed PAT in place");
        content.Should().Contain("session started", "the session-start marker should land as the first event");

        // UTC ISO 8601 timestamp with Z suffix on every event line.
        Regex.IsMatch(content, @"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z").Should().BeTrue();
    }

    [Fact]
    public async Task EndToEnd_host_shutdown_flushes_all_in_flight_events()
    {
        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");

        await using (var factory = new PRismWebApplicationFactory()
            .WithWebHostBuilder(b => b.ConfigureServices(s =>
            {
                s.AddSingleton<FileLoggerProvider>(_ => new FileLoggerProvider(_logsDir));
                s.AddSingleton<ILoggerProvider>(sp => sp.GetRequiredService<FileLoggerProvider>());
            })))
        {
            using var client = factory.CreateClient();
            var loggerFactory = factory.Services.GetRequiredService<ILoggerFactory>();
            var logger = loggerFactory.CreateLogger("PRism.IntegrationTest");

            for (var i = 0; i < 50; i++)
                logger.LogInformation("event {Index}", i);
        }

        var content = File.ReadAllText(todayPath);

        for (var i = 0; i < 50; i++)
            content.Should().Contain($"event {i}", $"event {i} should be persisted after graceful shutdown");
    }
}
