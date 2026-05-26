using System;
using System.IO;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;

using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Web.Logging;
using PRism.Web.Tests.TestHelpers;
using Xunit;

// Dual-derivation invariant test for the logsPath surfaced by GET /api/preferences
// (spec § 11.1, deferral sidecar `[Risk] LogsPathInfo singleton — dual-derivation
// invariant`). Two independent derivations exist:
//
//   (1) LogsPathInfo singleton — registered in Program.cs from `Path.Combine(dataDir, "logs")`
//       and read by the GET /api/preferences handler.
//   (2) FileLoggerProvider — registered by AddPRismFileLogger from the same dataDir
//       (FileLoggerExtensions.cs:34) and writes prism-YYYY-MM-DD.log into that dir.
//
// Both must point at the same directory. This test forces (2) on in the Test env via
// PRISM_FILE_LOGGER_FORCE=1, writes one log line, and asserts the file lands at the
// dir that (1) surfaces over the wire. If a future refactor splits the two derivations
// (versioned log roots, separate disk per provider, ...), this test bites before the
// Settings page ever surfaces a path no log file lives at.
//
// Use the LoggerExtensions API (LogInformation) because the producing call site needs
// the framework's normal logging surface — LoggerMessage.Define is unnecessary for the
// one-line probe.
#pragma warning disable CA1848, CA1727, CA1873

namespace PRism.Web.Tests.Endpoints;

[Collection("EnvVarSensitive")]
public sealed class PreferencesLogsPathDualDerivationTests : IDisposable
{
    private readonly string? _originalForceValue;

    public PreferencesLogsPathDualDerivationTests()
    {
        _originalForceValue = Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE");
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", "1");
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", _originalForceValue);
        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task GET_preferences_logsPath_matches_FileLoggerProvider_output_dir()
    {
        await using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        // Sanity: the override engaged — FileLoggerProvider is registered.
        factory.Services.GetService<FileLoggerProvider>().Should().NotBeNull(
            "PRISM_FILE_LOGGER_FORCE=1 should admit FileLoggerProvider under Test env");

        // (1) Read logsPath from the wire shape.
        var resp = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var wireLogsPath = body.GetProperty("github").GetProperty("logsPath").GetString();
        wireLogsPath.Should().NotBeNullOrWhiteSpace();

        // (2) Write a log line through the registered file logger and assert the file
        //     materialises under the directory the wire surfaced.
        var loggerFactory = factory.Services.GetRequiredService<ILoggerFactory>();
        var logger = loggerFactory.CreateLogger("PRism.IntegrationTest");
        logger.LogInformation("dual-derivation probe line");

        // Drain the writer task before assertions: explicitly disposing the FileLoggerProvider
        // (rather than waiting for factory teardown which would also wipe the DataDir).
        await factory.Services.GetRequiredService<FileLoggerProvider>().DisposeAsync();

        // Assert SOME `prism-YYYY-MM-DD.log` lives under the wire-surfaced dir. We deliberately
        // do not pin the exact filename to today's date: the FileLoggerProvider derives its
        // target file from each event's `Timestamp.LocalDateTime` per call (see
        // FileLoggerProvider.WriteEventAsync), so if the test crosses local midnight between
        // capturing "today" and the writer task scheduling, pinning to a pre-captured filename
        // produces a false negative. Listing the directory for any `prism-*.log` match keeps the
        // assertion robust through the rollover. Copilot review feedback on PR #69.
        var matches = Directory.GetFiles(wireLogsPath!, "prism-*.log");
        matches.Should().NotBeEmpty(
            $"expected the FileLoggerProvider to write a prism-YYYY-MM-DD.log into the same directory the wire surfaces as github.logsPath ({wireLogsPath})");

        // Belt-and-suspenders: assert (1) and (2) agree on the dir derivation, not just that
        // some file landed somewhere — `Path.Combine(factory.DataDir, "logs")` is the canonical
        // Program.cs derivation, so wireLogsPath must equal it.
        wireLogsPath.Should().Be(Path.Combine(factory.DataDir, "logs"));
    }
}
