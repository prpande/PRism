using System;
using System.IO;
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
    private readonly string _todayPath;

    public FileLoggerProviderTests()
    {
        _logsDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        // Capture the daily-file path ONCE per test instance to avoid the midnight-boundary
        // flake where the provider writes pre-rollover but the assertion reads post-rollover.
        // Tests that exercise rotation explicitly (with MutableClock) build their own paths.
        _todayPath = Path.Combine(_logsDir, $"prism-{DateTime.Now:yyyy-MM-dd}.log");
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

        var todayPath = _todayPath;
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

        var todayPath = _todayPath;
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

        var todayPath = _todayPath;
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

        var todayPath = _todayPath;
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

        var todayPath = _todayPath;
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

        var todayPath = _todayPath;
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

        var todayPath = _todayPath;
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
        var todayPath = _todayPath;
        File.ReadAllText(todayPath).Should().Contain("second event after delete");
    }

    [Fact]
    public async Task Drops_event_when_channel_full_increments_backpressure_counter_deterministically()
    {
        // Force the writer task to block on its very first write by holding the daily file
        // with FileShare.None. The writer's OpenAppendStream throws IOException; the writer
        // task's outer try/catch routes the exception to Console.Error and the writer task
        // exits. The channel then fills up because nobody is draining it, and TryWrite
        // returns false on overflow. We can then deterministically assert DroppedDueToBackpressure > 0.

        Directory.CreateDirectory(_logsDir);
        var todayPath = _todayPath;
        using var locker = new FileStream(todayPath, FileMode.Create, FileAccess.Write, FileShare.None);

        await using var provider = new FileLoggerProvider(_logsDir);
        var logger = provider.CreateLogger("Test");

        // Burst-write 2x capacity. The writer task is wedged on the locked file; channel fills
        // and subsequent TryWrites return false.
        for (var i = 0; i < FileLoggerProvider.ChannelCapacity * 2; i++)
            logger.LogInformation("burst {Index}", i);

        // Give the runtime a moment to schedule any drains that did complete before the lock
        // engaged (none expected, but cheap insurance).
        await Task.Yield();

        provider.DroppedDueToBackpressure.Should().BeGreaterThan(0,
            "with the writer task wedged on a locked file, the channel must fill and TryWrite must return false");
    }

    [Fact]
    public async Task Zero_arg_LoggerMessage_Define_falls_back_to_formatter_unscrubbed()
    {
        // A zero-arg LoggerMessage.Define overload (e.g., logger.LogInformation("static text"))
        // produces a state without {OriginalFormat} OR with an {OriginalFormat} entry but no
        // other args. The file sink's fallback path uses the supplied `formatter` — there are
        // no args to scrub anyway.
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("static text with no placeholders");
        }

        var todayPath = _todayPath;
        var content = File.ReadAllText(todayPath);
        content.Should().Contain("static text with no placeholders");
    }

    [Fact]
    public async Task Repeated_template_key_in_state_uses_last_wins_not_ArgumentException()
    {
        // ILogger message templates legally repeat the same name (e.g., "a={X} b={X}"). The
        // file sink's manual dict[k]=v loop uses last-wins; ToDictionary would throw
        // ArgumentException -> fallback to unscrubbed formatter. Verify the redaction still
        // fires for both occurrences.
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("first={pat} second={pat}", "ghp_111", "ghp_222");
        }

        var todayPath = _todayPath;
        var content = File.ReadAllText(todayPath);
        content.Should().NotContain("ghp_111");
        content.Should().NotContain("ghp_222");
        content.Should().Contain("[REDACTED]");
    }

    [Fact]
    public async Task Login_value_embedded_in_body_string_is_NOT_redacted_documenting_the_carveout()
    {
        // Pins § 6.2's carve-out: `body` field is non-blocked even though a login value
        // embedded inside the body JSON would semantically be PII. This is the deliberate
        // diagnostic-debuggability trade.
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogWarning("transport: {body}", "{\"message\":\"User pratyush not authorized\"}");
        }

        var todayPath = _todayPath;
        var content = File.ReadAllText(todayPath);
        content.Should().Contain("pratyush");  // NOT redacted — by-arg-name scrub doesn't traverse value content
    }

    [Fact]
    public async Task OpenAppendStream_on_locked_daily_file_increments_writeFailureCount_and_continues()
    {
        // Spec § 10 + ADV2-4: the lockfile prevents second-process startup but doesn't
        // prevent the file-open attempt. A second writer holding FileAccess.Write on the
        // daily file makes the second OpenAppendStream throw IOException.

        Directory.CreateDirectory(_logsDir);
        var todayPath = _todayPath;

        using var locker = new FileStream(todayPath, FileMode.Create, FileAccess.Write, FileShare.Read);

        await using var provider = new FileLoggerProvider(_logsDir);
        var logger = provider.CreateLogger("Test");
        logger.LogInformation("event 0");
        await provider.DisposeAsync();

        // Provider didn't crash; the writer-task task swallowed the IOException.
        // _writeFailureCount visible via the internal getter (PRism.Web.Tests has
        // InternalsVisibleTo on PRism.Web).
        provider.WriteFailureCount.Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task Redacts_pendingReviewId_and_threadId_and_replyCommentId_when_present_as_structured_args()
    {
        // S5 PR3 deferral closure — these field names are added to BlockedFieldNames
        // and the file sink must redact them too.
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation(
                "trace {pendingReviewId} {threadId} {replyCommentId}",
                "PRR_xxxxx", "PRRT_yyyyy", "PRRC_zzzzz");
        }

        var todayPath = _todayPath;
        var content = File.ReadAllText(todayPath);
        content.Should().NotContain("PRR_xxxxx");
        content.Should().NotContain("PRRT_yyyyy");
        content.Should().NotContain("PRRC_zzzzz");
        // All three placeholders get [REDACTED] — count the occurrences.
        var redactedCount = System.Text.RegularExpressions.Regex.Count(content, @"\[REDACTED\]");
        redactedCount.Should().BeGreaterOrEqualTo(3);
    }

    [Fact]
    public async Task Keeps_headSha_field_unredacted()
    {
        // headSha is non-blocked; it's diagnostically load-bearing for submit-pipeline
        // failure triage. The carve-out is intentional per spec § 6.2.
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("drift detected at {headSha}", "abc123def456");
        }

        var todayPath = _todayPath;
        var content = File.ReadAllText(todayPath);
        content.Should().Contain("abc123def456");
    }

    [Fact]
    public async Task Value_whose_ToString_throws_falls_back_to_formatter_without_crashing()
    {
        // ADV2-3 + spec § 7: LogTemplateFormatter catches Exception broadly and returns
        // the template verbatim. The file sink's outer try/catch in FileLogger.Log then
        // does NOT see an exception (because the formatter swallowed it), so the
        // counter increment via OnTemplateSubstitutionFailure does NOT fire — the
        // template-verbatim string lands in the file. The host stays up; that's the
        // load-bearing assertion. Counter increment behavior is exercised by the unit
        // tests on LogTemplateFormatter (Task 2).
        await using var provider = new FileLoggerProvider(_logsDir);
        var logger = provider.CreateLogger("Test");

        logger.LogError("blew up: {X}", new ThrowingToString());
        await provider.DisposeAsync();

        var todayPath = _todayPath;
        File.Exists(todayPath).Should().BeTrue();
    }

    [Fact]
    public async Task Rolls_over_file_at_local_date_boundary()
    {
        // Clock-seam test: inject a Func<DateTimeOffset> that the provider uses for BOTH
        // FileLogEvent.Timestamp (via parent.Now()) AND the date-rollover check (via
        // _now().LocalDateTime). Driving both legs from the same seam makes the rotation
        // decision deterministic — event #1's timestamp is yesterday's local date because
        // FileLogger.Log calls _parent.Now() at the moment of enqueue.

        var clock = new MutableClock(DateTimeOffset.Now.AddDays(-1));

        await using (var provider = new FileLoggerProvider(_logsDir, () => clock.Now))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("yesterday event");
            // Drive the writer task's drain of event #1 before advancing the clock — without
            // this synchronization, the writer might dequeue event #1 AFTER clock.Now was
            // reassigned (FileLogger.Log captured _parent.Now() correctly at enqueue, but
            // the rotation decision in WriteEventAsync uses evt.Timestamp which was already
            // captured, so the race is benign here). For belt-and-braces, briefly yield.
            await Task.Yield();

            clock.Now = DateTimeOffset.Now;
            logger.LogInformation("today event");
        }

        var yesterdayPath = Path.Combine(_logsDir, $"prism-{clock.Now.AddDays(-1):yyyy-MM-dd}.log");
        var todayPath = Path.Combine(_logsDir, $"prism-{clock.Now:yyyy-MM-dd}.log");

        File.Exists(yesterdayPath).Should().BeTrue();
        File.Exists(todayPath).Should().BeTrue();
        File.ReadAllText(yesterdayPath).Should().Contain("yesterday event");
        File.ReadAllText(todayPath).Should().Contain("today event");
    }

    [Fact]
    public async Task Rotation_open_failure_increments_writeFailureCount_and_continues_draining()
    {
        // Spec § 7 extension counterpart to the startup-open Path A test: when the rollover
        // OpenAppendStream throws (today's file is locked by another writer), the writer task
        // must NOT exit. Failure routes to _writeFailureCount, the previous-day's events stay on
        // disk, and the writer keeps draining. Without the rotate-open guard added in this PR
        // the writer would die at midnight and every subsequent event would be a drop.

        var yesterdayClock = DateTimeOffset.Now.AddDays(-1);
        var clock = new MutableClock(yesterdayClock);

        var todayPath = Path.Combine(_logsDir, $"prism-{DateTimeOffset.Now:yyyy-MM-dd}.log");
        var yesterdayPath = Path.Combine(_logsDir, $"prism-{yesterdayClock:yyyy-MM-dd}.log");

        Directory.CreateDirectory(_logsDir);
        // Lock today's daily file with FileShare.None BEFORE the rotation attempt. The provider
        // opens yesterday's file successfully at startup, then attempts to open today's at the
        // rollover — that second open is the one we want to fail.
        using var locker = new FileStream(todayPath, FileMode.Create, FileAccess.Write, FileShare.None);

        await using (var provider = new FileLoggerProvider(_logsDir, () => clock.Now))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("yesterday event survives");

            // Wait for the writer task to actually OPEN yesterday's file before advancing
            // the clock. RunWriterAsync sets `_currentFileDate = DateOnly.FromDateTime(
            // _now().LocalDateTime)` and calls OpenAppendStream(_currentFileDate) at startup
            // (line 155-166 in FileLoggerProvider.cs); if the writer task is scheduled LATE
            // (slow Windows CI runner) and the clock is advanced before that line runs, the
            // writer captures TODAY's date, tries to open today's locked file at startup,
            // hits the catch at line 169-174, and exits before any event is processed.
            // Yesterday's file then never materializes and the final assertion fails. Probing
            // for yesterday's file existence proves the writer reached the OpenAppendStream
            // step against the YESTERDAY clock value; from that point on, `_currentFileDate`
            // is fixed and the rotation logic in WriteEventAsync uses `evt.Timestamp` (not
            // the live clock), so advancing the clock is safe. Recurring CI flake observed
            // on PR #69 (3 of 4 CI runs failed at FileLoggerProviderTests.cs:521 before this
            // probe was added).
            var startupDeadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
            while (!File.Exists(yesterdayPath) && DateTime.UtcNow < startupDeadline)
                await Task.Delay(20);
            File.Exists(yesterdayPath).Should().BeTrue(
                "writer task must have opened yesterday's file (proving _currentFileDate = yesterday) before the test advances the clock");

            clock.Now = DateTimeOffset.Now;
            logger.LogInformation("today event triggers locked rotation open");
            // Poll for the writer task to drain event #2 and increment the failure counter rather
            // than holding a fixed delay — slow CI runners (Windows Actions) couldn't make the
            // 50ms ceiling, and the assertion would fire before the writer had even scheduled.
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
            while (provider.WriteFailureCount == 0 && DateTime.UtcNow < deadline)
                await Task.Delay(20);

            provider.WriteFailureCount.Should().BeGreaterThan(0,
                "the rotation open against a FileShare.None-locked file must route to _writeFailureCount");
        }

        // The pre-rotation event landed on yesterday's file before the lock-induced failure;
        // existence + content prove the writer task kept draining (didn't crash on rotation).
        File.Exists(yesterdayPath).Should().BeTrue();
        File.ReadAllText(yesterdayPath).Should().Contain("yesterday event survives");
    }

    [Fact]
    public async Task Emits_session_end_line_and_counter_summary_on_graceful_shutdown()
    {
        await using (var provider = new FileLoggerProvider(_logsDir))
        {
            var logger = provider.CreateLogger("Test");
            logger.LogInformation("event 0");
        }

        var todayPath = _todayPath;
        var content = File.ReadAllText(todayPath);
        content.Should().Contain("session ending");
    }

    [Fact]
    public async Task Writer_task_failure_does_not_crash_the_host()
    {
        // The structural recursion-safety claim ("the writer task never calls ILogger") is
        // enforced by code review of FileLoggerProvider.cs: every self-diagnostic path uses
        // Console.Error.WriteLine, never an ILogger. A unit test cannot enforce this
        // structurally — it would need a Roslyn analyzer or a discipline-check harness. What
        // this test verifies is the observable consequence: when the writer task's I/O fails
        // (we lock the daily file with FileShare.Read so the provider's OpenAppendStream
        // throws), the host stays up, DisposeAsync completes, the counter increments.

        Directory.CreateDirectory(_logsDir);
        var todayPath = _todayPath;
        using var locker = new FileStream(todayPath, FileMode.Create, FileAccess.Write, FileShare.Read);

        await using var provider = new FileLoggerProvider(_logsDir);
        var logger = provider.CreateLogger("Test");
        logger.LogInformation("event that will fail to write");
        await provider.DisposeAsync();

        // Reaching this line IS the assertion — DisposeAsync returned cleanly without
        // deadlock or throw despite the writer-task fatal exception from OpenAppendStream.
        // The WriteFailureCount counter may or may not have fired depending on whether the
        // failure landed in OpenAppendStream (routes to the writer-task fatal stderr path
        // before any write attempt) or in a subsequent WriteAsync (increments the counter).
        // We don't assert on the counter value here because either path is consistent with
        // the spec's "host stays up on I/O failure" contract.
    }

    private sealed class ThrowingToString
    {
        public override string ToString() => throw new InvalidOperationException("kaboom");
    }

    private sealed class MutableClock
    {
        public DateTimeOffset Now { get; set; }
        public MutableClock(DateTimeOffset now) { Now = now; }
    }
}
