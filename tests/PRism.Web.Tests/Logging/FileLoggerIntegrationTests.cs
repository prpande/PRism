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

    // Read a file with a short polling-retry on IOException("used by another process").
    // On slow Windows CI runners the FileLoggerProvider's DisposeAsync chain
    // (factory → service-provider → FileLoggerProvider.DisposeAsync → _currentStream
    // .DisposeAsync) can race with the test resuming after `await using`: if the
    // 2-second writer-task drain budget is exhausted and the channel still has
    // events, the cancel + dispose path catches exceptions silently and the stream
    // can briefly remain open from the OS's perspective even after `await using`
    // returns. Polling for `File.ReadAllText` to succeed (or fail with a different
    // error) is the surgical fix without enlarging the provider's drain budget,
    // which would slow every other test. Caught by recurring CI flake on PR #69.
    private static async Task<string> ReadAllTextWithRetryAsync(
        string path,
        TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            try
            {
                return await File.ReadAllTextAsync(path).ConfigureAwait(false);
            }
            catch (IOException) when (DateTime.UtcNow < deadline)
            {
                await Task.Delay(50).ConfigureAwait(false);
            }
        }
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

        var content = await ReadAllTextWithRetryAsync(todayPath, TimeSpan.FromSeconds(5));

        content.Should().NotContain("ghp_secret_test", "the literal PAT value must not appear on disk");
        content.Should().Contain("[REDACTED]", "the scrubber must replace the PAT");
        content.Should().Contain("auth failed with [REDACTED]", "the formatted line should have the scrubbed PAT in place");
        content.Should().Contain("session started", "the session-start marker should land as the first event");

        // UTC ISO 8601 timestamp with Z suffix on every event line.
        Regex.IsMatch(content, @"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z").Should().BeTrue();
    }

    [Fact]
    public async Task EndToEnd_pat_in_exception_text_and_nonsensitive_arg_is_scrubbed_on_disk()
    {
        // Regression for #610: the file sink never ran LogScrub, so a PAT in free text —
        // an exception's .ToString() or an arg under a non-sensitive key — reached disk verbatim
        // and persisted for the 14-day retention window. The field-name scrubber only redacts
        // values whose structured KEY is sensitive (`pat`/`token`/…), so neither path below is
        // caught by it; only the free-text backstop redacts them.
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

            // (a) PAT embedded in an exception message — written via exception?.ToString(),
            //     which the field-name scrubber never touches.
            var ex = new InvalidOperationException(
                "GET https://x:ghp_exceptiontoken1234567890abcd@api.github.com/repos failed");
            logger.LogError(ex, "request pipeline failed");

            // (b) PAT passed positionally under a NON-sensitive key — the key `detail` is not in
            //     SensitiveFieldScrubber's blocklist, so the value survives field-name scrubbing
            //     and only the free-text backstop catches it.
            logger.LogError("auth detail: {detail}", "token ghp_freetextarg0987654321zyxw rejected");
        }

        File.Exists(todayPath).Should().BeTrue($"the daily log file should exist at {todayPath}");
        var content = await ReadAllTextWithRetryAsync(todayPath, TimeSpan.FromSeconds(5));

        content.Should().NotContain("ghp_exceptiontoken", "a PAT in exception text must not reach disk");
        content.Should().NotContain("ghp_freetextarg", "a PAT in a non-sensitive-keyed arg must not reach disk");
        content.Should().Contain("[REDACTED]", "the free-text scrubber must replace PAT-shaped tokens");
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

        var content = await ReadAllTextWithRetryAsync(todayPath, TimeSpan.FromSeconds(5));

        for (var i = 0; i < 50; i++)
            content.Should().Contain($"event {i}", $"event {i} should be persisted after graceful shutdown");
    }
}
