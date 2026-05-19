using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Web.Logging;

// These tests exercise the file logger via the standard LoggerExtensions API
// (LogInformation / LogWarning / LogError) on purpose: the whole point is to
// validate behavior when the SUT is called the way ASP.NET callers call it.
// LoggerMessage.Define-style call sites would defeat that. Per-test scenarios
// vary the template and arg count, so a fixed delegate is not a meaningful
// substitute. Suppressing the LoggerExtensions-related analyzers file-scoped:
//   CA1848 — use LoggerMessage delegates instead of LoggerExtensions
//   CA1727 — use PascalCase named placeholders (tests intentionally use
//            lowercase `pat`, `login`, `body` to mirror real scrub field names)
//   CA1873 — lazy evaluation of expensive logging args (synthetic test values)
#pragma warning disable CA1848, CA1727, CA1873

namespace PRism.Web.Tests.Logging;

public sealed class FileLoggerProviderTests : IDisposable
{
    private readonly string _logsDir;

    public FileLoggerProviderTests()
    {
        _logsDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
    }

    public void Dispose()
    {
#pragma warning disable CA1031 // Best-effort temp-dir cleanup in test teardown.
        try { if (Directory.Exists(_logsDir)) Directory.Delete(_logsDir, recursive: true); }
        catch (Exception) { /* best-effort cleanup */ }
#pragma warning restore CA1031
        GC.SuppressFinalize(this);
    }

    [Fact]
    public async Task Creates_logs_directory_on_first_write()
    {
        Directory.Exists(_logsDir).Should().BeFalse();

        await using var provider = new FileLoggerProvider(_logsDir);
        var logger = provider.CreateLogger("Test");
        logger.LogInformation("hello");

        await provider.DisposeAsync();

        Directory.Exists(_logsDir).Should().BeTrue();
    }

    [Fact]
    public async Task Emits_session_start_line_as_first_event_in_the_file()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("hello");
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var lines = File.ReadAllLines(todayPath);

        lines.Should().NotBeEmpty();
        lines[0].Should().Contain("session started");
        lines[0].Should().Contain($"processId={Environment.ProcessId}");
    }

    [Fact]
    public async Task Writes_formatted_line_with_utc_timestamp_and_category_and_level()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("PRism.Test.Category");
            logger.LogWarning(new EventId(42, "MyEvent"), "hello {Name}", "world");
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var content = File.ReadAllText(todayPath);

        content.Should().Contain("[Warning]");
        content.Should().Contain("PRism.Test.Category");
        content.Should().Contain("[42]");
        content.Should().Contain("hello world");
        // UTC timestamp ISO 8601 with Z suffix
        content.Should().MatchRegex(@"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z");
    }

    [Fact]
    public async Task Redacts_pat_field_when_present_as_structured_arg()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogError("auth failed with {pat}", "ghp_supersecret_xxxxxxxxxxxxxx");
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var content = File.ReadAllText(todayPath);

        content.Should().NotContain("ghp_supersecret");
        content.Should().Contain("[REDACTED]");
    }

    [Fact]
    public async Task Redacts_login_field_when_present_as_structured_arg()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("validated as {login}", "pratyush");
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var content = File.ReadAllText(todayPath);

        content.Should().NotContain("pratyush");
        content.Should().Contain("[REDACTED]");
    }

    [Fact]
    public async Task Keeps_body_field_unredacted()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogWarning("transport failed: {body}", "{\"message\":\"Bad credentials\"}");
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var content = File.ReadAllText(todayPath);

        content.Should().Contain("Bad credentials");
    }

    [Fact]
    public async Task Writes_exception_ToString_on_indented_continuation_lines()
    {
        Exception thrown;
        try { throw new InvalidOperationException("kaboom"); }
#pragma warning disable CA1031 // Synthetic test exception capture.
        catch (Exception ex) { thrown = ex; }
#pragma warning restore CA1031

        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogError(thrown, "failed");
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var lines = File.ReadAllLines(todayPath);

        // The message line first, then exception lines indented with 4 spaces.
        var failedLine = Array.FindIndex(lines, l =>
            l.Contains("failed", StringComparison.Ordinal)
            && !l.StartsWith("    ", StringComparison.Ordinal));
        failedLine.Should().BeGreaterOrEqualTo(0);
        var nextLine = lines[failedLine + 1];
        nextLine.Should().StartWith("    ");
        nextLine.Should().Contain("InvalidOperationException");
        nextLine.Should().Contain("kaboom");
    }

    [Fact]
    public async Task Retention_sweep_deletes_files_older_than_retention_days()
    {
        Directory.CreateDirectory(_logsDir);
        // 14 days = FileLoggerProvider.RetentionDays; spec § 4.5.
        var oldDate = DateTime.Now.AddDays(-20);
        var oldPath = Path.Combine(_logsDir, $"prism-{oldDate:yyyy-MM-dd}.log");
        File.WriteAllText(oldPath, "old content");

        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("trigger writer task");
        }
        // DisposeAsync drains the writer task, which has already run RunRetentionSweep
        // as its first action (before draining the channel). The sweep is therefore
        // complete by the time DisposeAsync returns — no Task.Delay needed.

        File.Exists(oldPath).Should().BeFalse();
    }

    [Fact]
    public async Task Retention_sweep_keeps_files_at_exactly_retention_days_old()
    {
        Directory.CreateDirectory(_logsDir);
        var atBoundary = DateTime.Now.AddDays(-14);
        var atPath = Path.Combine(_logsDir, $"prism-{atBoundary:yyyy-MM-dd}.log");
        File.WriteAllText(atPath, "at boundary");

        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("trigger writer task");
        }

        // Boundary is `> RetentionDays`, not `>=`, so 14-days-old is kept.
        File.Exists(atPath).Should().BeTrue();
    }

    [Fact]
    public async Task Retention_sweep_keeps_non_matching_filenames()
    {
        Directory.CreateDirectory(_logsDir);
        var unrelatedPath = Path.Combine(_logsDir, "prism.log.bak");
        File.WriteAllText(unrelatedPath, "unrelated");

        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("trigger writer task");
        }

        File.Exists(unrelatedPath).Should().BeTrue();
    }

    [Fact]
    public async Task Shutdown_flushes_pending_events_before_stream_close()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            for (var i = 0; i < 20; i++)
                logger.LogInformation("event {Index}", i);
        }

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        var content = File.ReadAllText(todayPath);

        for (var i = 0; i < 20; i++)
            content.Should().Contain($"event {i}");
    }

    [Fact]
    public async Task Logs_directory_recreated_on_provider_reopen_after_manual_delete()
    {
        // ADV2 § 12.5: OpenAppendStream calls Directory.CreateDirectory before opening
        // the FileStream. This test pins the self-healing on reopen (a new provider after
        // dispose). Mid-session manual delete with an open stream handle is OS-specific:
        // on Windows the handle is invalidated; on Linux the file inode lives until the
        // handle closes. v1 doesn't test that path because the recovery would require
        // FileStream-watching to detect the deletion mid-write — out of scope.

        await using (var provider1 = new FileLoggerProvider(_logsDir))
        {
            var logger = provider1.CreateLogger("Test");
            logger.LogInformation("first event");
        }
        Directory.Exists(_logsDir).Should().BeTrue();

        // User deletes the directory between sessions.
        Directory.Delete(_logsDir, recursive: true);
        Directory.Exists(_logsDir).Should().BeFalse();

        // Second provider's writer task runs Directory.CreateDirectory + OpenAppendStream's
        // own Directory.CreateDirectory, self-healing the deleted directory.
        await using (var provider2 = new FileLoggerProvider(_logsDir))
        {
            var logger2 = provider2.CreateLogger("Test");
            logger2.LogInformation("second event after delete");
        }

        Directory.Exists(_logsDir).Should().BeTrue();
        var todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
        File.ReadAllText(todayPath).Should().Contain("second event after delete");
    }
}
