---
title: "On-disk log writer for PRism.Web"
date: 2026-05-18
status: design
revisions:
  - 2026-05-18: brainstorm pass — design committed for ce-doc-review + human review
related:
  - 2026-05-11-s5-submit-pipeline-deferrals.md   # closes the [Defer] on-disk log writer entry (lines 848, 926)
  - 2026-05-06-s3-pr-detail-read-deferrals.md    # partially addresses the SensitiveFieldScrubber wire-up deferral
  - 2026-05-10-multi-account-scaffold-deferrals.md # absorbs the P3 advisory on `login` as PII
---

# On-disk log writer for PRism.Web

## 1. Origin and goal

PRism's backend has no on-disk log. `WebApplication.CreateBuilder(args)` registers the default Console + Debug `ILoggerProvider`s and no `ConfigureLogging` override is in place. When a user closes the `.\run.ps1` terminal, every backend diagnostic emitted up to that point is gone. PR #55 (the submit-flash hotfix) was a concrete case: the structured `ILogger` delegates added there (`s_graphqlSubmitFailed`, `s_graphqlReadFailed`, `s_graphqlTransportFailed`, `s_graphqlSubmitNoData`) emit rich data, but the data dies with the console window.

The S5 deferrals doc records this as `[Defer] On-disk log writer for PRism.Web` (`docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:848` and the carry-forward at line 926). The slice also opportunistically absorbs the S3 PR5 deferral `[Defer] Wire SensitiveFieldScrubber into the live ILogger pipeline as a decorator` (`docs/plans/2026-05-06-s3-pr-detail-read-deferrals.md:169`) **for the file sink only** — see § 1.2 for the bounded scope. And it absorbs the multi-account-scaffold deferral `[Risk] login is GitHub-supplied PII (P3 advisory)` (`docs/specs/2026-05-10-multi-account-scaffold-deferrals.md`) by adding `login` to the scrubber's blocked-field list.

The intent is narrow: when a user reports a failure after the fact, we want a file under the data directory that captures the structured-log stream from the most recent session(s), with PRism-known secrets redacted before they hit disk.

### 1.1 Use cases the slice serves

1. **Post-mortem diagnosis after the user closes `run.ps1`.** The user files an issue; we ask for `<dataDir>/logs/prism-YYYY-MM-DD.log` excerpts; the structured fields PR #55 already emits are now on disk.
2. **`gh issue` paste-friendliness.** Plain text format, one event per line, exceptions on indented continuation lines — copies cleanly into an issue body.
3. **Local-dev introspection while developing PRism itself.** Same file, no separate tooling.

### 1.2 Alternative considered, not chosen — factory-level decorator that scrubs Console + Debug too

The original S3 PR5 deferral asks for a factory-level `ILogger`-wrapping decorator that intercepts every structured-log scope across every provider. That shape is materially larger than file-sink-internal redaction:

- `LoggerMessage.Define<T0,T1,…>` produces a strongly-typed source-generated state struct used by 16 PRism log sites. Its `IReadOnlyList<KeyValuePair<string, object?>>` projection is read-only; a decorator can't mutate values in place.
- To redact universally, the decorator has to re-run the format template against a scrubbed key/value list. That requires owning a small template formatter (`{Name}`, `{Name:format}`, `{Name,alignment}`, escaped `{{`/`}}` — the M.E.Logging template grammar) plus a substitute state-wrapper type whose `ToString()` returns the re-formatted string and whose enumeration returns the scrubbed args.
- Estimated cost: ~200 LOC of template-substitution machinery + a separate test surface for parser edge cases, on top of the file sink itself.

The threat model is "user closed run.ps1, console is gone, only disk artifact remains." That vector is fully closed by file-sink-internal redaction. Console-leak-while-user-tails is speculative for a single-user local PoC where the console reader IS the user, in their own terminal, on their own machine. YAGNI argues for the narrower slice; the broader decorator stays as a forward-looking deferral, with revised reasoning, so it remains visible if the threat model expands.

## 2. Non-goals

- **Universal factory-level redaction (Console + Debug + future providers).** File sink only. The S3 PR5 deferral stays open for the universal path; see § 11.
- **Size-based rotation or total-disk-cap.** Date-based rotation + N-day retention only. A 100MB-day on a single-user PoC is implausible; if it ever happens, the user can grep + delete; deferral entry captures the option.
- **Structured / machine-parseable format (NDJSON, etc.).** Plain text per § 1.1. Deferral entry if a triage tool ever materializes.
- **Scope dispatch into the file sink.** `BeginScope` is a no-op in v1. No PRism log site currently relies on scope context for downstream readers. Deferral entry if that changes.
- **Regex-based PAT-shape scrub of `Exception.Message` / `Exception.StackTrace`.** Field-name redaction only. Existing discipline ("never put a PAT in an exception message") is auditable via grep; the regex pass costs CPU per event and has false-positive risk.
- **Cross-process log aggregation.** One PRism.Web process per host (lockfile-enforced via `LockfileManager`). Single-writer assumption holds.

## 3. Approach in one paragraph

A new `PRism.Web.Logging.FileLoggerProvider` registers as an additional `ILoggerProvider` alongside Console + Debug. Each `FileLogger` (one per category, framework-managed) reads the structured-log state on `Log<TState>`, scrubs each value via the existing `SensitiveFieldScrubber.Scrub(name, value)`, re-formats the template against the scrubbed values into a single plain-text line, and enqueues a `FileLogEvent` on a bounded `Channel<FileLogEvent>`. A single background writer task drains the channel, appends to today's `<dataDir>/logs/prism-YYYY-MM-DD.log` (UTF-8, append mode, `FileShare.Read`), rolls over at local midnight, and flushes after every event. A 14-day retention sweep runs once on writer-task startup. An `IHostedService` adapter (`FileLoggerLifecycle`) ties the writer task's start/stop to the host lifetime so shutdown drains pending events. The slice also adds `"login"` to `SensitiveFieldScrubber.BlockedFieldNames`.

## 4. Components

### 4.1 `FileLoggerProvider`

`PRism.Web/Logging/FileLoggerProvider.cs`. Implements `ILoggerProvider`, `IAsyncDisposable`. Owns:

- `Channel<FileLogEvent>` (bounded, capacity from `FileLoggerOptions.ChannelCapacity` default 1024).
- Current `FileStream` (initialised on first event; never null after startup).
- Current file's `DateOnly` (local date).
- `_droppedCount` (`long`, `Interlocked` increment) — events that failed `TryWrite` because the channel was full.
- `_writeFailureCount` (`long`) — writer-task I/O failures.
- `_retentionFailureCount` (`long`) — retention-sweep `File.Delete` failures (reported in the shutdown stderr summary).
- The writer task `Task` handle.
- `FileLoggerOptions` snapshot (captured at construction; not hot-reloaded).

`CreateLogger(string categoryName)` returns `new FileLogger(categoryName, this)`.

`Dispose()` / `DisposeAsync()` close the channel writer, await the drain task with a 2-second timeout, flush + close the stream. Best-effort; never throws.

### 4.2 `FileLogger`

`PRism.Web/Logging/FileLogger.cs` (or sibling). Implements `ILogger`. Holds `(string category, FileLoggerProvider parent)`. Behavior:

- `IsEnabled(LogLevel level)` returns `true`. The framework's filter pipeline (`Logger<T>` in `Microsoft.Extensions.Logging`) applies the configured `Logging:LogLevel:*` rules **and** calls each provider's `IsEnabled` — both must return true for the event to flow. Returning a stricter floor here (e.g., `>= Information`) would silently override the `appsettings.Development.json` `"PRism": "Debug"` setting and prevent `Debug` events from ever reaching the file even when the user explicitly enabled them. The file sink trusts the framework's filter result.
- `BeginScope<TState>(TState state)` returns `NullScope.Instance` (no-op disposable). v1 ignores scopes; see § 11.
- `Log<TState>(LogLevel, EventId, TState, Exception?, Func<TState, Exception?, string>)`:
  1. If `state is IReadOnlyList<KeyValuePair<string, object?>> kvList`: extract `{OriginalFormat}` entry (the template); build a dictionary of `name → SensitiveFieldScrubber.Scrub(name, value)` for the remaining entries; re-format the template via the local `LogTemplateFormatter`. If `{OriginalFormat}` is absent or template-substitution throws, fall back to `formatter(state, exception)`.
  2. Else: `formatted = formatter(state, exception)`.
  3. Build `new FileLogEvent(DateTimeOffset.UtcNow, level, category, eventId, formatted, exception?.ToString())`.
  4. `parent.TryEnqueue(evt)` — non-blocking; on false, `Interlocked.Increment(ref _droppedCount)`.

### 4.3 `FileLogEvent`

`internal readonly record struct FileLogEvent(DateTimeOffset Timestamp, LogLevel Level, string Category, EventId EventId, string FormattedMessage, string? ExceptionString);`

All fields are pre-resolved on the request thread so the writer task does pure I/O. No `TState` boxing; no deferred formatter invocation.

### 4.4 `LogTemplateFormatter`

`PRism.Web/Logging/LogTemplateFormatter.cs`. Static helper.

```csharp
internal static class LogTemplateFormatter
{
    public static string Format(string template, IReadOnlyDictionary<string, object?> values);
}
```

Parses M.E.Logging template syntax:

- `{Name}` — substitute by name.
- `{Name:format}` — substitute by name, apply format via `IFormattable.ToString(format, CultureInfo.InvariantCulture)` (fall back to `value?.ToString()` if not `IFormattable`).
- `{Name,alignment}` — substitute by name, apply width alignment (left if negative).
- `{Name,alignment:format}` — both.
- `{{` and `}}` — literal `{` / `}`.

Missing-key behavior: leave the placeholder text intact (`"{MissingName}"`). Misformed template: return template verbatim plus log to stderr once. The implementation MAY internally delegate to `string.Format` with a positional re-map (named → indexed via the dictionary's enumeration), or implement a small hand-written parser. Test coverage in § 8 enumerates the cases either implementation must satisfy.

### 4.5 `FileLoggerOptions`

```csharp
internal sealed class FileLoggerOptions
{
    public string LogsDir { get; set; } = "";           // populated from dataDir at registration
    public int RetentionDays { get; set; } = 14;
    public int ChannelCapacity { get; set; } = 1024;
}
```

Bound from `Logging:File` section in `appsettings.json` (optional; defaults apply if section absent).

### 4.6 `FileLoggerLifecycle`

`PRism.Web/Logging/FileLoggerLifecycle.cs`. Implements `IHostedService`. Constructor takes `FileLoggerProvider`. `StartAsync` triggers the writer task and the retention sweep. `StopAsync` triggers provider disposal (awaits drain with 2s budget).

The choice of `IHostedService` over lazy-start-in-first-`Log` is deliberate: it ties the writer to the host lifetime so shutdown happens in the correct order (after every other hosted service has stopped logging), and the retention sweep gets a definite "startup" moment to run.

### 4.7 `AddPRismFileLogger` extension

`PRism.Web/Logging/FileLoggerExtensions.cs`:

```csharp
public static ILoggingBuilder AddPRismFileLogger(this ILoggingBuilder builder, string dataDir)
{
    builder.Services.Configure<FileLoggerOptions>(o =>
    {
        o.LogsDir = Path.Combine(dataDir, "logs");
    });
    builder.Services.AddOptions<FileLoggerOptions>()
        .BindConfiguration("Logging:File");  // appsettings overrides

    builder.Services.AddSingleton<FileLoggerProvider>();
    builder.Services.AddSingleton<ILoggerProvider>(sp => sp.GetRequiredService<FileLoggerProvider>());
    builder.Services.AddHostedService<FileLoggerLifecycle>();
    return builder;
}
```

Binding order: the `Configure` callback runs **before** `BindConfiguration`, so an `appsettings.json` override for `Logging:File:LogsDir` would replace the dataDir-relative default. v1 documents this in the options class XML doc; no PRism use case currently sets it, but a teammate who wants logs under a different root (e.g., a tmpfs for performance) can.

### 4.8 Updated `SensitiveFieldScrubber`

`PRism.Web/Logging/SensitiveFieldScrubber.cs` — add `"login"` to `BlockedFieldNames`:

```csharp
private static readonly string[] BlockedFieldNames =
{
    "subscriberId",
    "pat",
    "token",
    "pendingReviewId",
    "threadId",
    "replyCommentId",
    "login",   // 2026-05-18: GitHub-supplied username; PII per multi-account-scaffold deferral.
};
```

Existing public surface unchanged. The class stays `internal sealed` with a static `Scrub` method.

## 5. Data flow

```
[request thread]
ILogger.Log<TState>(level, eventId, state, exception, formatter)
    |
    +-- [framework filter pipeline] -- if filtered, return.
    |
    +-- [Console / Debug providers] receive unchanged (state, formatter).
    |
    +-- [FileLogger.Log<TState>]
            |
            +-- if state is IReadOnlyList<KV>:
            |       template     = state.Last(kv => kv.Key == "{OriginalFormat}").Value as string
            |       scrubbed     = state.Where(kv => kv.Key != "{OriginalFormat}")
            |                          .ToDictionary(kv => kv.Key,
            |                                        kv => SensitiveFieldScrubber.Scrub(kv.Key, kv.Value))
            |       formatted    = LogTemplateFormatter.Format(template, scrubbed)
            |   else:
            |       formatted    = formatter(state, exception)
            |
            +-- evt = new FileLogEvent(UtcNow, level, category, eventId, formatted, exception?.ToString())
            +-- parent.TryEnqueue(evt) -- non-blocking
                    |
                    +-- channel.Writer.TryWrite(evt) returns false (channel full):
                            Interlocked.Increment(ref _droppedCount); return.

[writer task -- single thread, started by FileLoggerLifecycle.StartAsync]
on entry:
    Directory.CreateDirectory(opts.LogsDir);
    RunRetentionSweep();
    _currentFileDate = DateOnly.FromDateTime(DateTime.Now);
    _currentStream  = OpenAppendStream(_currentFileDate);

await foreach FileLogEvent in channel.Reader.ReadAllAsync(stoppingToken):
    var today = DateOnly.FromDateTime(evt.Timestamp.LocalDateTime);
    if (today != _currentFileDate) {
        await _currentStream.FlushAsync(); _currentStream.Dispose();
        _currentFileDate = today;
        _currentStream  = OpenAppendStream(today);
    }
    try {
        await _currentStream.WriteAsync(Format(evt));
        await _currentStream.FlushAsync();
    }
    catch (Exception ex) {
        Interlocked.Increment(ref _writeFailureCount);
        Console.Error.WriteLine($"PRism FileLogger write failed: {ex.Message}"); // once per session
    }

on shutdown:
    channel.Writer.Complete();
    await drain (already in foreach);
    if (_droppedCount > 0) writeFinalLine(Warning, $"N log events were dropped due to channel backpressure.");
    if (_writeFailureCount > 0) Console.Error.WriteLine($"PRism FileLogger had N write failures this session.");
    await _currentStream.FlushAsync(); _currentStream.Dispose();
```

`OpenAppendStream(DateOnly d)` builds the path `<LogsDir>/prism-{d:yyyy-MM-dd}.log` and returns `new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read)`.

`Format(FileLogEvent evt)` produces:

```
2026-05-18T14:30:21.123Z [Information] PRism.Web.Endpoints.PrSubmitEndpoints[3]: POST /submit rejected for owner/repo/42: head SHA drifted (last viewed abc123, current def456). The user must Reload before retrying.
```

If `evt.ExceptionString` is non-null, append on a separate indented block:

```
    System.InvalidOperationException: example
       at PRism.Web.Endpoints.PrSubmitEndpoints.SubmitAsync(...) in /path/to/file.cs:line 99
```

Multi-line exceptions get each line prefixed with four spaces so grep + skim still works.

## 6. File lifecycle details

- **Path**: `<dataDir>/logs/prism-YYYY-MM-DD.log`. Directory created on writer-task startup with `Directory.CreateDirectory` (idempotent).
- **Date semantics**: file *date* is local time (rollover at local midnight). Per-event *timestamp* is UTC with `Z` suffix. The asymmetry is intentional — operators expect "today's log" to roll over at local midnight, but per-event timestamps want to be unambiguous across DST and TZ boundaries.
- **Encoding**: UTF-8 without BOM (matches the project-wide convention from PowerShell 7+).
- **Append mode**: a host restart on the same day continues the same file. A user who deletes the file mid-session sees the writer's next write recreate it (FileStream with `FileMode.Append` creates on demand).
- **`FileShare.Read`**: another process (e.g., a teammate running `Get-Content -Wait`) can tail the file without contention. We don't share `Write` because no other PRism writer should exist (lockfile-enforced).
- **Rotation trigger**: date check on every event in the writer task. The "first event after local midnight" closes the previous stream and opens the new file. No timer; no background tick; deterministic.
- **Retention sweep**: runs once on writer-task startup. Enumerates `<LogsDir>/prism-*.log`, parses the date suffix (regex `^prism-(\d{4}-\d{2}-\d{2})\.log$`), deletes files where `(today - fileDate).Days > RetentionDays`. Non-matching filenames (e.g., `prism.log.bak`, `notes.txt`) are skipped silently. Each `File.Delete` is wrapped in `try/catch (IOException, UnauthorizedAccessException)`; a failure increments `_retentionFailureCount` reported to stderr at shutdown.
- **Flush cadence**: `await FlushAsync()` after every event. A host crash loses at most the in-flight event. Throughput-bounded but adequate for a single-user PoC; if a future debug-flood proves it costly we can batch (deferral entry).

## 7. Error handling

| Failure | Path | User-visible signal |
|---|---|---|
| Channel full (capacity 1024) on `TryWrite` | Increment `_droppedCount`; drop the event silently. | Final shutdown line: `[Warning] PRism.Web.Logging.FileLogger: N log events were dropped due to channel backpressure during this session.` |
| `FileStream.WriteAsync` / `FlushAsync` throws (disk full, file-system corruption, AV lock) | Increment `_writeFailureCount`; emit one stderr line `PRism FileLogger write failed: <message>`. Writer continues draining (subsequent writes may succeed). | One stderr line per session (rate-limited via `if (_writeFailureCount == 1)`); shutdown summary `PRism FileLogger had N write failures this session.` |
| Date-rollover stream-open fails | Same as I/O failure above. `_currentStream` stays on the prior date; subsequent events keep writing to yesterday's file until the open succeeds. | Stderr line. |
| Retention sweep `File.Delete` failure | Increment `_retentionFailureCount`; continue sweep loop. | Shutdown summary `PRism FileLogger could not delete N stale log files this session.` |
| Template substitution throws (malformed `{OriginalFormat}`, unexpected value type, etc.) | Catch; fall back to `formatter(state, exception)`; log to stderr once per session. | Stderr line; the event still lands in the file with the formatter's plain output. |
| `OperationCanceledException` from the drain loop | Expected on shutdown. Don't log; don't increment counters. | None. |

The recursion rule: **the writer task never calls `ILogger`.** All writer-task self-diagnostics go to `Console.Error`. This avoids a failing file sink feeding itself.

## 8. Test coverage

`tests/PRism.Web.Tests/Logging/`:

### 8.1 `FileLoggerProviderTests` — unit tests, no host

- `CreatesLogsDirectory_OnFirstWrite`
- `WritesFormattedLine_WithUtcTimestamp_AndCategory_AndLevel_AndEventId`
- `RedactsPatField_WhenPresentAsStructuredArg`
- `RedactsLoginField_WhenPresentAsStructuredArg` *(new — bundled multi-account-scaffold deferral)*
- `RedactsPendingReviewIdAndThreadIdAndReplyCommentId` *(S5 PR3 deferral closure)*
- `KeepsBodyField_Unredacted` *(regression net for the spec § 6.2 P2.8 carve-out)*
- `KeepsHeadShaField_Unredacted`
- `WritesExceptionToString_OnIndentedContinuationLines`
- `DropsEvent_WhenChannelFull_AndIncrementsDroppedCount`
- `FinalShutdownLine_NamesDroppedCount_WhenNonZero`
- `RollsOverFile_AtLocalDateBoundary` *(uses `Func<DateTime>` clock seam injected via internals-visible-to)*
- `RetentionSweep_DeletesFilesOlderThanRetentionDays`
- `RetentionSweep_KeepsNonMatchingFilenames`
- `RetentionSweep_KeepsFilesAtExactlyRetentionDaysOld` *(boundary test — > not ≥)*
- `Shutdown_FlushesPendingEvents_BeforeStreamClose`
- `IoFailureOnWrite_DoesNotThrow_AndContinuesDraining_AndEmitsOneStderrLine`
- `RecreatesLogsDirectory_IfDeletedAtRuntime` *(see § 12.5)*
- `WriterTask_DoesNotCallILogger_OnAnyFailurePath` *(introspection on `ListLoggerProvider` records)*

### 8.2 `LogTemplateFormatterTests` — focused on the substitution path

- `SimpleNamedPlaceholder_Substitutes`
- `MissingKey_LeavesPlaceholderIntact`
- `FormatSpecifier_AppliedToFormattable` *(e.g., `{Count:N0}` on `int 1234` → `1,234`)*
- `AlignmentSpecifier_AppliedAsWidth` *(`{Code,5}` on `"foo"` → `"  foo"`)*
- `EscapedBraces_RendersLiteralBraces`
- `MalformedTemplate_ReturnsTemplateVerbatim_AndDoesNotThrow`
- `NullValue_RendersAsEmptyString`
- `MultipleOccurrencesOfSameName_AllSubstituted`

### 8.3 `FileLoggerIntegrationTests` — `WebApplicationFactory<Program>`-driven

- `EndToEnd_StructuredLogWithPatField_ProducesFileWithRedactedValue`:
  spins up the host with a temp `DataDir`, fires a known structured-log event with `pat: "ghp_secret_test"` (via a tiny test-only endpoint or via an existing endpoint that touches the structured-log code path), asserts (i) the expected file path exists, (ii) the literal `ghp_secret_test` does NOT appear in the file, (iii) `[REDACTED]` does appear, (iv) the timestamp is parseable as UTC ISO 8601. **This is the load-bearing regression test for the slice.**
- `EndToEnd_HostShutdown_FlushesAllInFlightEvents`:
  fires N events, triggers `IHostApplicationLifetime.StopApplication`, asserts all N appear in the file.

### 8.4 `SensitiveFieldScrubberTests` — extension

- Add `[InlineData("login")]` and `[InlineData("Login")]` to the existing redaction theory. Rename `Redacts_submit_pipeline_field_names` to `Redacts_blocked_field_names` to reflect the broader set.

Total new tests: ~24 new test cases + 2 theory data rows.

## 9. Wiring change in `Program.cs`

Single addition, after the `dataDir` resolution line (currently `PRism.Web/Program.cs:39`):

```csharp
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

builder.Logging.AddPRismFileLogger(dataDir);   // <-- new

builder.Services.AddPrismCore(dataDir);
// ... rest unchanged.
```

No other production-code touchpoints. The Console + Debug providers stay registered (`WebApplication.CreateBuilder` adds them by default); the file sink is additive.

### 9.1 Test-host implications

`WebApplicationFactory<Program>`-based xUnit tests will also wire the file sink under their temp `DataDir`. This is fine — each test gets its own temp dir and the writer task cleans up on `IAsyncDisposable.DisposeAsync` via the host lifetime. The `IoFailureOnWrite_DoesNotThrow_AndContinuesDraining` test asserts that even if the temp dir is forcibly deleted mid-test, the host doesn't crash.

Playwright (`PRISM_E2E_FAKE_REVIEW=1` / `PRISM_E2E_REAL_INJECT=1`) similarly inherits the file sink under its `DataDir`. This is a side-benefit: real-flow e2e failures now leave on-disk evidence in the test data directory.

## 10. Architectural invariants this slice maintains

- **No new third-party dependencies.** Uses only `Microsoft.Extensions.Logging`, `System.Threading.Channels`, `System.IO` — all in the BCL.
- **`AtomicFileMove` discipline preserved for state writes.** Logs are append-only and not load-bearing — they don't use the atomic-rename primitive. The `Storage/` namespace stays focused on state.
- **`SensitiveFieldScrubber` location unchanged** (`PRism.Web/Logging/`). Slice expands its blocklist by one entry; doesn't move it to `PRism.Core`.
- **No recursion through ILogger from the sink's failure paths.** Writer task uses `Console.Error.WriteLine` exclusively for self-diagnostics.
- **Source-gen `LoggerMessage.Define` continues to work unchanged.** The sink interprets `IReadOnlyList<KV>` projection (which source-gen output supports); no change to call sites.
- **Lockfile + single-process invariant.** `LockfileManager.Acquire` already guarantees one PRism.Web per dataDir; the writer's `FileShare.Read` is safe.

## 11. Out of scope (deferrals this slice ships)

Each lands as an entry in `docs/specs/2026-05-18-on-disk-log-writer-deferrals.md` (created alongside this spec).

- **[Defer] Factory-level `ILogger`-wrapping decorator for universal redaction across Console + Debug + future providers.** Revised reasoning from S3 PR5: file sink covers the load-bearing post-mortem case; universal decorator requires ~200 LOC of template-substitution machinery and protects against speculative leak vectors for a PoC.
- **[Defer] Size-based rotation / total-disk-cap retention.** Date-based 14-day retention is sufficient for single-user PoC throughput. Revisit if a debug-flood day occurs.
- **[Defer] NDJSON / structured machine-parseable format.** Plain text is gh-issue-friendly; revisit when a triage tool needs structured input.
- **[Defer] `BeginScope` dispatch into the file sink.** v1 returns `NullScope.Instance`. Revisit when a PRism log site adds scope context that downstream readers need.
- **[Defer] Regex-based PAT-shape scrub of exception messages and stack traces.** Field-name redaction only. Revisit if an exception-message leak is reported in a real incident.
- **[Defer] Hot-reload of `FileLoggerOptions`.** Options are snapshot at construction. Changing `RetentionDays` or `ChannelCapacity` requires a host restart. Revisit if a deployment scenario emerges that warrants dynamic config.
- **[Defer] Flush-batching for throughput.** v1 flushes per event. Revisit if a debug-flood proves the eager-flush cost dominates.

## 12. Risks and forward-looking hazards

### 12.1 Channel-bounded drops on a debug-flood

Capacity 1024 is fine for steady-state. A misbehaving subsystem emitting `Debug`-level events in a tight loop could fill the channel. Mitigation: framework `Logging:LogLevel:Default = Information` (current `appsettings.json`) keeps the threshold high in production. Dev runs `PRism = Debug` per `appsettings.Development.json` but is also where the user is watching the console. The drop-count signal at shutdown surfaces the symptom.

### 12.2 Local-time date rollover near DST transitions

At the spring-forward boundary, two events 1 second apart could be on different "local dates" if the boundary lands between them. Accepted: worst case is one extra file rotation; the file's date matches the event's local date which is what an operator expects. At fall-back, events with timestamps in the repeated hour land in the same-named file (no rotation back); per-event UTC timestamps disambiguate within the file.

### 12.3 `LogTemplateFormatter` parser surface area

The M.E.Logging template grammar is documented but the parser must handle `{Name}`, `{Name:format}`, `{Name,alignment}`, `{Name,alignment:format}`, `{{`, `}}`. Test coverage in § 8.2 enumerates the cases. Implementation MAY use `string.Format` with a positional re-map (named → indexed via dictionary key ordering) to lean on the BCL's well-tested format engine; the test surface stays the same.

### 12.4 Drain-timeout-on-shutdown elides events

The 2-second drain timeout on `Dispose` means a slow disk could leave the tail of the channel un-persisted. Accepted: 2s is generous for the steady-state flow; a sustained-2s-flush per event would indicate disk-level pathology where the broader system has bigger problems. The dropped-count and write-failure counters surface the symptom.

### 12.5 `<dataDir>/logs/` directory removed under us

If a user manually deletes the logs directory while the host runs, the next stream open would fail. Fix: `OpenAppendStream(DateOnly d)` calls `Directory.CreateDirectory(opts.LogsDir)` before opening the FileStream (idempotent; cheap). The rotation path therefore self-heals against a manually-deleted directory. Test `RecreatesLogsDirectory_IfDeletedAtRuntime` pins this. (Add this test to § 8.1's list.)

### 12.6 PR #55 log delegates touch live identifiers

PR #55 added `s_graphqlSubmitFailed`, `s_graphqlReadFailed`, `s_graphqlTransportFailed`, `s_graphqlSubmitNoData` in `PRism.GitHub/GitHubReviewService*.cs`. These take an error-body string truncated to 1024 chars. The body may contain GitHub-supplied identifiers (PR numbers, commit SHAs, comment IDs). None of these are PRism's blocked field names, but a future GitHub error format change could include `login` or `pat`-shape strings in the body. The slice's scrub-by-field-name approach won't catch these — the body lands in a structured arg named `body` or `responseBody`, which is on the never-blocked list (per spec § 6.2 P2.8). Acceptable: GitHub error bodies are diagnostic; we trade redaction for debuggability per the existing carve-out. Documented for the next reviewer who wonders why.

## 13. Open questions

None at design time. All substantive questions were resolved during the brainstorm pass; mechanical defaults (UTF-8, append mode, `FileShare.Read`, retention 14 days, channel capacity 1024) are recorded with their reasoning in § 6.

## 14. Acceptance

This slice is done when:

1. `<dataDir>/logs/prism-YYYY-MM-DD.log` exists and contains structured log lines after a normal `run.ps1` session.
2. A log line that would have carried a PAT value contains `[REDACTED]` and not the PAT.
3. The same for `login`, `pendingReviewId`, `threadId`, `replyCommentId`.
4. The 14-day retention sweep removes stale files on startup.
5. Date rollover at local midnight starts a new file.
6. Host shutdown drains pending events; no events are lost on graceful stop.
7. A disk-full or I/O-failure scenario does not crash the host.
8. All ~24 new tests + 2 theory rows pass.
9. The integration test `EndToEnd_StructuredLogWithPatField_ProducesFileWithRedactedValue` is the load-bearing assertion that the slice's primary contract holds end-to-end.
