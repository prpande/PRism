---
title: "On-disk log writer for PRism.Web"
date: 2026-05-18
status: design
revisions:
  - 2026-05-18: brainstorm pass — design committed for ce-doc-review + human review
  - 2026-05-18: ce-doc-review pass 1 applied — 6-persona review (coherence + feasibility + product-lens + security-lens + scope-guardian + adversarial). Applied: (a) split `SensitiveFieldScrubber.Scrub` into `ScrubFieldName` (redaction-only, file-sink uses) + `Scrub` (combined redact-and-truncate, existing direct callers keep); (b) pinned `LogTemplateFormatter` impl to single-pass `string.Format` positional re-map — explicitly forbid `.Replace`-style parser (closes the recursion hazard); (c) replaced naïve `ToDictionary` over KV list with manual `dict[k] = v` loop (last-wins on duplicate template keys; closes the `ArgumentException → fallback unscrubbed` defect); (d) collapsed `FileLoggerLifecycle` into `FileLoggerProvider.DisposeAsync` (no separate `IHostedService`); (e) replaced `FileLoggerOptions` + `BindConfiguration` ceremony with compile-time `FileLoggerConstants` (PoC has zero consumers); (f) gated `Program.cs` registration on `!IsEnvironment("Test")` to sidestep 111 × test-factory drain budget; (g) split drop counter into `_droppedDueToBackpressure` + `_droppedDuringShutdown` so the session-end summary names the right cause; (h) added a session-start marker line as the first event in every file (operator boundary marker for multi-session files); (i) added § 1.2 alternatives-considered section covering Serilog + run.ps1-tee (the original draft only weighed the universal-decorator alternative); (j) added § 6.2 field-redaction-policy table (resolves the broken `§ 6.2 P2.8` cross-reference); (k) tightened the `login` framing to "preventive extension" (no current log site emits it); (l) tightened § 12.6's gap acknowledgement with the `login` blocklist addition; (m) updated test list to ~30 tests covering the four new correctness fixes. Deferred-considered: regex-over-formatter scrub alternative, opportunity-cost analysis, premise-evidence justification (user explicitly chose this work; the post-mortem framing holds for PoC scope). New deferrals appended to the sidecar: Serilog as alternative, run.ps1-tee as alternative, Playwright env-var hook, dedicated stderr file.
  - 2026-05-18: ce-doc-review pass 2 applied — 4-persona pass (coherence + feasibility + security-lens + adversarial). **Two material new defects found and fixed:** (1) FEAS-1 / ADV2-1 / SEC-8 (3-persona agreement, conf 100+75+75): the post-Build `AddProvider` wiring in § 9 doesn't work — `LoggerFactory.AddProvider` after `Build()` doesn't propagate to already-resolved `Logger<T>` instances, and `LoggerFactory.Dispose()` invokes sync `Dispose()` not `DisposeAsync()`, breaking the drain contract. Inverted to pre-Build registration with the `IsEnvironment("Test")` gate moved INSIDE the extension method itself; § 9 now documents the pre-Build shape as canonical with the lockfile-ordering acknowledgement that lockfile cannot enforce the single-writer invariant for the file sink (OS-level `FileShare.Read` semantics do). (2) FEAS-2 (conf 100): `EmitSessionStartLine` was called before `_currentStream` was opened in the § 5 pseudocode — reordered. Also applied: § 4.4 broad `catch (Exception)` instead of `catch (FormatException)` (ADV2-3 — `string.Format` doesn't wrap value-`ToString()` throws as `FormatException` on .NET 10); § 4.7 `ScrubFieldName` scoped to `internal sealed` with code-review-discipline note (SEC-5); § 4.1 counter-race acknowledgement as "best-effort under shutdown contention" (ADV2-2); § 12.5 `opts.LogsDir → _logsDir` and dropped stale "Add this test to § 8.1's list" parenthetical (Coherence CO-2/CO-3); fixed broken `§ 4.8` reference in § 4.2 to `§ 4.7` (Coherence CO-1 — section renumbered when Lifecycle was collapsed); added tests `OpenAppendStream_OnLockedDailyFile_IncrementsWriteFailureCount_AndContinues` (ADV2-4 — lockfile-file-sink coupling) and `ValueWhoseToStringThrows_FallsBackToFormatter_AndIncrementsParserFailureCounter` (ADV2-3). Deferred (low-priority): SEC-6 session-start PII (processId + version travels off-machine when logs are shared) — documented as informational; SEC-7 compile-time RetentionDays as operational-security constraint — acknowledged in § 4.5 phrasing already.
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

### 1.2 Alternatives considered

Three alternatives were weighed and rejected. Each is captured here so the rationale outlives this brainstorm; the unselected paths land as deferrals (§ 11) with explicit revisit triggers.

**(a) Factory-level `ILogger`-wrapping decorator that scrubs Console + Debug too.** This is the original S3 PR5 deferral wording. `LoggerMessage.Define<T0,T1,…>` produces a strongly-typed source-generated state struct used by 16 PRism log sites; its `IReadOnlyList<KeyValuePair<string, object?>>` projection is read-only. To redact universally, the decorator must own a small template formatter (`{Name}`, `{Name:format}`, `{Name,alignment}`, escaped `{{`/`}}`) plus a substitute state-wrapper type whose `ToString()` returns the re-formatted string. The threat model is "user closed run.ps1, console is gone, only disk artifact remains" — fully closed by file-sink-internal redaction. Console-leak-while-user-tails is speculative for a single-user local PoC where the console reader IS the user. Rejected on YAGNI grounds; deferral entry preserves the option.

**(b) Serilog with a destructuring policy or filter enricher.** `Serilog.Sinks.File` already handles rolling, retention, and shared-read; a `Filter.With<IEventFilter>` or `Destructure.ByTransforming<T>` would implement the field-name redaction in ~50 LOC of config. Trade: adds three NuGet packages (`Serilog`, `Serilog.Extensions.Logging`, `Serilog.Sinks.File`) where today the project has zero third-party logging deps. Rejected because (i) the slice that follows ALSO has the redaction mechanism in a co-resident place (the sink), so the LOC delta is smaller than it looks once tests are counted; (ii) PRism's "minimum new dependencies" discipline is asserted across the architectural-readiness doc; (iii) Serilog's filter/enricher contract is a different shape from `SensitiveFieldScrubber` and either we keep our scrubber + write a Serilog adapter (two abstractions doing the same job) or we replace `SensitiveFieldScrubber` (and break its existing direct-call site at `PrDraftsDiscardAllEndpoint.cs:97`). Deferral entry captures the option in case the maintenance trade flips.

**(c) `run.ps1` `Tee-Object` to a file (zero in-process code).** Modify `run.ps1` so the host's stdout is piped into a date-named file: `.\Program.exe | Tee-Object -FilePath logs\prism-$(Get-Date -F yyyy-MM-dd).log`. Zero new C# code; no redaction infrastructure; the file is whatever the console renders. Rejected because (i) the user-facing PowerShell `run.ps1` is the developer-launch entry only — `dotnet run`, IDE launches, Playwright-spawned hosts, and CI all bypass it, so the diagnostic disappears in the cases the slice cares most about; (ii) redaction can't be added at the tee layer without forking the console formatter into PowerShell-side post-processing (a much larger maintenance footprint than the in-process sink); (iii) console formatter output strips structured-arg keys, so the field-name scrub the slice depends on becomes impossible. This option is genuinely cheap if the slice didn't care about redaction or about non-`run.ps1` launches — both of which it does.

The selected path (file-sink-internal redaction, BCL-only) is documented in § 3 onwards. The chosen tradeoff is one named alternative for each axis: scope (a), library choice (b), launch coverage (c).

## 2. Non-goals

- **Universal factory-level redaction (Console + Debug + future providers).** File sink only. The S3 PR5 deferral stays open for the universal path; see § 11.
- **Size-based rotation or total-disk-cap.** Date-based rotation + N-day retention only. A 100MB-day on a single-user PoC is implausible; if it ever happens, the user can grep + delete; deferral entry captures the option.
- **Structured / machine-parseable format (NDJSON, etc.).** Plain text per § 1.1. Deferral entry if a triage tool ever materializes.
- **Scope dispatch into the file sink.** `BeginScope` is a no-op in v1. No PRism log site currently relies on scope context for downstream readers. Deferral entry if that changes.
- **Regex-based PAT-shape scrub of `Exception.Message` / `Exception.StackTrace`.** Field-name redaction only. Existing discipline ("never put a PAT in an exception message") is auditable via grep; the regex pass costs CPU per event and has false-positive risk.
- **Cross-process log aggregation.** One PRism.Web process per host (lockfile-enforced via `LockfileManager`). Single-writer assumption holds.

## 3. Approach in one paragraph

A new `PRism.Web.Logging.FileLoggerProvider` registers as an additional `ILoggerProvider` alongside Console + Debug, gated on `!IsEnvironment("Test")` (so xUnit `WebApplicationFactory<Program>`-based tests don't all spin up writer tasks against temp DataDirs — see § 9.1). Each `FileLogger` (one per category, framework-managed) reads the structured-log state on `Log<TState>`, scrubs each value via a new `SensitiveFieldScrubber.ScrubFieldName(name, value)` (redaction-only; the existing combined `Scrub` keeps its current truncation behavior for direct callers), re-formats the template via a `string.Format` positional re-map into a single plain-text line, and enqueues a `FileLogEvent` on a bounded `Channel<FileLogEvent>`. A single background writer task — started in the provider's constructor — drains the channel, appends to today's `<dataDir>/logs/prism-YYYY-MM-DD.log` (UTF-8, append mode, `FileShare.Read`), rolls over at local midnight, and flushes after every event. A 14-day retention sweep runs once on writer-task startup. Provider `DisposeAsync` (called by the DI container during host teardown) signals the channel to drain and flush. The slice also adds `"login"` to `SensitiveFieldScrubber.BlockedFieldNames`.

## 4. Components

### 4.1 `FileLoggerProvider`

`PRism.Web/Logging/FileLoggerProvider.cs`. Implements `ILoggerProvider`, `IAsyncDisposable`. Owns:

- `Channel<FileLogEvent>` (bounded, capacity from `FileLoggerOptions.ChannelCapacity` default 1024).
- Current `FileStream` (initialised on first event; never null after startup).
- Current file's `DateOnly` (local date).
- `_droppedDueToBackpressure` (`long`, `Interlocked` increment) — events that failed `TryWrite` because the channel was full while the host was running normally.
- `_droppedDuringShutdown` (`long`, `Interlocked` increment) — events that failed `TryWrite` because the channel writer had already been completed (host shutting down). Reported separately so the operator's post-mortem reads the correct cause. **Best-effort under shutdown contention**: a request thread that calls `TryWrite` exactly between `_shutdownStarted = 1` and `channel.Writer.Complete()` may attribute a backpressure drop to the shutdown counter (small race window). The split is intended as a normal-operation vs shutdown-elision disambiguation, not a strict count under concurrent shutdown — sufficient for post-mortem operator-readability.
- `_writeFailureCount` (`long`) — writer-task I/O failures.
- `_retentionFailureCount` (`long`) — retention-sweep `File.Delete` failures (reported in the shutdown stderr summary).
- `_shutdownStarted` (`int` used as bool via `Interlocked`) — set to 1 by `DisposeAsync` before completing the channel writer; the request-thread path reads it to decide which counter to bump on `TryWrite` returning false.
- The writer task `Task` handle.
- Internal `FileLoggerConstants` (see § 4.5) — compile-time constants for `RetentionDays = 14` and `ChannelCapacity = 1024`. `LogsDir` is supplied as a constructor parameter from `AddPRismFileLogger(dataDir)`.

`CreateLogger(string categoryName)` returns `new FileLogger(categoryName, this)`.

`Dispose()` / `DisposeAsync()` set `_shutdownStarted = 1`, close the channel writer, await the drain task with a 2-second timeout, flush + close the stream. Best-effort; never throws. The DI container calls `DisposeAsync` on registered `IAsyncDisposable` singletons during host teardown, after all `IHostedService` instances have stopped — so the drain happens after every other logging consumer has gone quiet. No separate `IHostedService` lifecycle adapter is needed (rejected during ce-doc-review; a lifecycle hosted service would have duplicated the disposal contract without adding new behavior).

### 4.2 `FileLogger`

`PRism.Web/Logging/FileLogger.cs` (or sibling). Implements `ILogger`. Holds `(string category, FileLoggerProvider parent)`. Behavior:

- `IsEnabled(LogLevel level)` returns `true`. The framework's filter pipeline (`Logger<T>` in `Microsoft.Extensions.Logging`) applies the configured `Logging:LogLevel:*` rules **and** calls each provider's `IsEnabled` — both must return true for the event to flow. Returning a stricter floor here (e.g., `>= Information`) would silently override the `appsettings.Development.json` `"PRism": "Debug"` setting and prevent `Debug` events from ever reaching the file even when the user explicitly enabled them. The file sink trusts the framework's filter result. **Note:** this guarantee holds for the DI-resolved `ILogger<T>` path. A future caller who resolves `FileLoggerProvider` directly and invokes `CreateLogger(...)` bypasses the framework filter pipeline — the singleton is registered as `internal`-only access (no public consumer in the AddPRism pipeline) to discourage that path. § 4.7 names the registration shape that enforces this.
- `BeginScope<TState>(TState state)` returns `NullScope.Instance` (no-op disposable). v1 ignores scopes; see § 11.
- `Log<TState>(LogLevel, EventId, TState, Exception?, Func<TState, Exception?, string>)`:
  1. If `state is IReadOnlyList<KeyValuePair<string, object?>> kvList`: extract the `{OriginalFormat}` entry (the template). Iterate the remaining KV entries with a manual `dict[key] = ScrubFieldName(key, value)` assignment (last-wins on duplicate keys — template syntax permits the same name twice; `ToDictionary` would throw `ArgumentException` and fall back to the unscrubbed formatter). Re-format the template via `LogTemplateFormatter.Format(template, dict)` (which delegates to `string.Format` with a positional re-map — see § 4.4). If `{OriginalFormat}` is absent (zero-arg `LoggerMessage.Define` overload, whose source-gen state has no template to substitute) or template-substitution throws, fall back to `formatter(state, exception)`.
  2. Else: `formatted = formatter(state, exception)`.
  3. Build `new FileLogEvent(DateTimeOffset.UtcNow, level, category, eventId, formatted, exception?.ToString())`.
  4. `parent.TryEnqueue(evt)` — non-blocking. On `TryWrite` returning false, increment `_droppedDuringShutdown` if `_shutdownStarted == 1`, else `_droppedDueToBackpressure`. The two counters report different operator-actionable causes (drained-by-shutdown vs channel-overflowing-while-running).

**Important:** the file sink uses `SensitiveFieldScrubber.ScrubFieldName` (redaction-only) — NOT the existing `SensitiveFieldScrubber.Scrub` which ALSO truncates strings > 1024 chars (see § 4.7 for the API split). The file sink's job is redaction; truncation is a separate concern that direct callers (e.g., `PrDraftsDiscardAllEndpoint.cs:97`) opt into explicitly. `ScrubFieldName` is `internal sealed`-scoped — direct external callers should use `Scrub` (which carries the size guard); future code that wants the redaction-only path inside `PRism.Web` should use `ScrubFieldName` but acknowledge in code review that the size guard is theirs to handle.

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

**Implementation contract (pinned, not "MAY"):** the formatter rewrites named M.E.Logging placeholders to BCL positional placeholders via a single-pass scan, then delegates to `string.Format(CultureInfo.InvariantCulture, rewrittenTemplate, args)`. Leaning on the BCL's format engine is the chosen path; a hand-written `.Replace`-style parser is **explicitly forbidden** because it has a recursion hazard (substituted values may themselves contain text shaped like `{OtherName}`, which a sweep-and-replace would then substitute on the second pass — leaking adjacent arg values into the first arg's rendered position).

The single-pass scan recognises M.E.Logging template grammar:

- `{Name}` → BCL `{0}`
- `{Name:format}` → BCL `{0:format}` (e.g., `{Count:N0}` on `int 1234` → `1,234`)
- `{Name,alignment}` → BCL `{0,alignment}` (left if negative; `{Code,5}` on `"foo"` → `"  foo"`)
- `{Name,alignment:format}` → BCL `{0,alignment:format}`
- `{{` and `}}` — preserved as literal escaped braces (BCL `{{` / `}}` semantics)

For each named placeholder, the scanner appends `values[name]` (or `null` if missing) to the positional `args[]` array in the order encountered. Missing-key behavior: pass `null` as the corresponding arg (renders as empty string under `string.Format`). Misformed template OR a value's `ToString()` / `IFormattable.ToString(format, IFormatProvider)` throws: catch `Exception` (broad — `string.Format` does NOT wrap value-formatter exceptions in `FormatException` on .NET 10), return the template verbatim, increment a parser-failure counter, write one stderr line per session. The broad catch is deliberate: a narrow `catch (FormatException)` would let a `NullReferenceException` from a value's `ToString()` propagate out of `FileLogger.Log<TState>` — a silent-drop attack surface that the framework's per-provider wrapper only partially mitigates.

`string.Format` is single-pass — once a positional placeholder is substituted, the result is not re-scanned. A scrubbed value of `"{login}"` (literal string) substituted into the first position renders verbatim; the second positional substitution operates on a fresh segment. Recursion hazard closed by construction.

### 4.5 `FileLoggerConstants`

`PRism.Web/Logging/FileLoggerProvider.cs` — private nested type or top-of-file static:

```csharp
internal static class FileLoggerConstants
{
    public const int RetentionDays  = 14;
    public const int ChannelCapacity = 1024;
}
```

No `IOptions<T>` binding, no `appsettings.json` override. Hot-reload is a deferred concern (§ 11); the PoC has zero deployment scenarios that warrant the binding ceremony. `LogsDir` is supplied as a constructor parameter from `AddPRismFileLogger(dataDir)` — see § 4.7. Changing either constant requires a recompile, which matches the PoC's release cadence.

### 4.6 `AddPRismFileLogger` extension

`PRism.Web/Logging/FileLoggerExtensions.cs`:

```csharp
public static ILoggingBuilder AddPRismFileLogger(this ILoggingBuilder builder, string dataDir)
{
    var logsDir = Path.Combine(dataDir, "logs");
    builder.Services.AddSingleton<FileLoggerProvider>(_ => new FileLoggerProvider(logsDir));
    builder.Services.AddSingleton<ILoggerProvider>(sp => sp.GetRequiredService<FileLoggerProvider>());
    return builder;
}
```

No options binding. No hosted service. The provider's constructor starts the writer task; the DI container calls `DisposeAsync` on the registered singleton during host teardown, which drains the channel.

`Program.cs` gates registration on `!IsEnvironment("Test")` (see § 9) — `WebApplicationFactory<Program>`-based tests don't accidentally spin up writer tasks against 111 temp DataDirs in parallel. The integration tests in § 8.3 explicitly opt in via a separate registration shape.

### 4.7 Updated `SensitiveFieldScrubber`

`PRism.Web/Logging/SensitiveFieldScrubber.cs` — two changes:

**(a)** Add `"login"` to `BlockedFieldNames`. This is a **preventive** extension per the multi-account-scaffold P3 advisory (`docs/specs/2026-05-10-multi-account-scaffold-deferrals.md`) — no current PRism log site emits `login` as a structured arg. The addition guards against a future site that does. **Scope note**: this protection covers top-level structured args named `login` only. Username values embedded inside JSON strings passed as `body` / `responseBody` / `ErrorsJson` args (S5 PR #55's truncated-body delegates do this) are NOT redacted — see § 12.6 for the explicit carve-out and rationale.

```csharp
private static readonly string[] BlockedFieldNames =
{
    "subscriberId",
    "pat",
    "token",
    "pendingReviewId",
    "threadId",
    "replyCommentId",
    "login",   // 2026-05-18: preventive — GitHub-supplied username; PII per multi-account-scaffold deferral.
};
```

**(b)** Split the existing public surface into two methods, separating redaction from truncation:

```csharp
// New: redaction-only. Used by FileLogger.Log<TState> to scrub structured args before
// re-formatting. Returns "[REDACTED]" for blocked field names; returns value unchanged
// for all other fields (no truncation).
public static object? ScrubFieldName(string fieldName, object? value);

// Existing: redaction + 1024-char truncation. Kept for direct callers (currently
// PrDraftsDiscardAllEndpoint.cs:97) who explicitly want the truncation guard. The
// file sink does NOT route through this — see § 4.2 step 1.
public static object? Scrub(string fieldName, object? value);
```

The split closes the contract gap surfaced during ce-doc-review: the file sink's data-flow promised "re-substitute against scrubbed values" — but the existing combined `Scrub` ALSO silently truncated strings > 1024 chars, which would have produced an on-disk file with `[truncated, original-length: N]` suffixes that aren't in the console output. The two-method split keeps the sink's output faithful to the format-template intent while preserving the existing call site's truncation behavior unchanged.

`Scrub` internally calls `ScrubFieldName` first, then applies truncation if the result is still a `string` longer than 1024 chars. Existing test cases for `Scrub` continue to pass without modification.

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
            |       template = null; scrubbedDict = new Dictionary<string, object?>();
            |       foreach (kv in state) {
            |           if (kv.Key == "{OriginalFormat}") template = kv.Value as string;
            |           else scrubbedDict[kv.Key] = ScrubFieldName(kv.Key, kv.Value);  // last-wins on dup keys
            |       }
            |       if (template != null) {
            |           try { formatted = LogTemplateFormatter.Format(template, scrubbedDict); }
            |           catch { formatted = formatter(state, exception);  // fallback unscrubbed }
            |       } else {
            |           formatted = formatter(state, exception);  // zero-arg overload: no template to substitute
            |       }
            |   else:
            |       formatted = formatter(state, exception)
            |
            +-- evt = new FileLogEvent(UtcNow, level, category, eventId, formatted, exception?.ToString())
            +-- parent.TryEnqueue(evt):
                    bool ok = channel.Writer.TryWrite(evt);
                    if (!ok) {
                        if (Volatile.Read(ref _shutdownStarted) == 1)
                            Interlocked.Increment(ref _droppedDuringShutdown);
                        else
                            Interlocked.Increment(ref _droppedDueToBackpressure);
                    }

[writer task -- single thread, started in FileLoggerProvider constructor]
on entry:
    Directory.CreateDirectory(_logsDir);
    RunRetentionSweep();
    _currentFileDate = DateOnly.FromDateTime(DateTime.Now);
    _currentStream  = OpenAppendStream(_currentFileDate);
    EmitSessionStartLine();        // writes to _currentStream — must run AFTER OpenAppendStream

await foreach FileLogEvent in channel.Reader.ReadAllAsync(stoppingToken):
    var today = DateOnly.FromDateTime(evt.Timestamp.LocalDateTime);
    if (today != _currentFileDate) {
        await _currentStream.FlushAsync(); _currentStream.Dispose();
        _currentFileDate = today;
        _currentStream  = OpenAppendStream(today);  // also calls Directory.CreateDirectory (idempotent)
    }
    try {
        await _currentStream.WriteAsync(Format(evt));
        await _currentStream.FlushAsync();
    }
    catch (Exception ex) {
        Interlocked.Increment(ref _writeFailureCount);
        if (_writeFailureCount == 1)  // rate-limited: one stderr line per session
            Console.Error.WriteLine($"PRism FileLogger write failed: {ex.Message}");
    }

on shutdown (DisposeAsync called by DI container after IHostedServices stop):
    Interlocked.Exchange(ref _shutdownStarted, 1);
    channel.Writer.Complete();
    await drain (existing foreach drains until Complete is observed);
    write a final session-end line with counter summary (see below);
    await _currentStream.FlushAsync(); _currentStream.Dispose();

EmitSessionStartLine():
    Write a synthetic line: "<UtcTimestamp> [Information] PRism.Web.Logging.FileLogger[0]: session started, processId=<N>, version=<assembly version>"
    This is the boundary marker operators grep for when post-mortem-reading a multi-session file.

Session-end summary at shutdown:
    Write "<UtcTimestamp> [Information] PRism.Web.Logging.FileLogger[1]: session ending, processId=<N>"
    If _droppedDueToBackpressure > 0:
        Write "[Warning] PRism.Web.Logging.FileLogger[2]: {N} log events were dropped due to channel backpressure during this session."
    If _droppedDuringShutdown > 0:
        Write "[Information] PRism.Web.Logging.FileLogger[3]: {N} log events were elided during host shutdown drain."
    If _writeFailureCount > 0:
        Console.Error.WriteLine($"PRism FileLogger had {N} write failures this session.")
    If _retentionFailureCount > 0:
        Console.Error.WriteLine($"PRism FileLogger could not delete {N} stale log files this session.")
```

`OpenAppendStream(DateOnly d)` builds the path `<_logsDir>/prism-{d:yyyy-MM-dd}.log`, calls `Directory.CreateDirectory(_logsDir)` first (idempotent — self-heals against a manually-deleted logs directory), then returns `new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read)`.

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

### 6.1 Path, date, format

- **Path**: `<dataDir>/logs/prism-YYYY-MM-DD.log`. Directory created with `Directory.CreateDirectory` inside `OpenAppendStream` (idempotent; self-heals if deleted at runtime).
- **Date semantics**: file *date* is local time (rollover at local midnight). Per-event *timestamp* is UTC with `Z` suffix. The asymmetry is intentional — operators expect "today's log" to roll over at local midnight, but per-event timestamps want to be unambiguous across DST and TZ boundaries.
- **Rollover boundary semantics**: the rotation check runs in the writer task against `DateOnly.FromDateTime(evt.Timestamp.LocalDateTime)`. If a queue backlog spans local midnight, events with pre-midnight timestamps that drain after midnight still land in the previous file (their `Timestamp.LocalDateTime` is yesterday's); events with post-midnight timestamps trigger the rotation. Files therefore contain "events whose local date equals the file's date" — not "events drained during the file's date window." Operators grep by per-event UTC timestamp, not by file date, when chronology matters.
- **Encoding**: UTF-8 without BOM (matches the project-wide convention from PowerShell 7+).
- **Append mode**: a host restart on the same day continues the same file. A user who deletes the file mid-session sees the writer's next write recreate it.
- **`FileShare.Read`**: another process (e.g., a teammate running `Get-Content -Wait`) can tail the file without contention. We don't share `Write` because no other PRism writer should exist (lockfile-enforced via `LockfileManager`; see § 9 for the registration-ordering invariant).
- **Rotation trigger**: date check on every event in the writer task. The "first event after local midnight" closes the previous stream and opens the new file. No timer; no background tick; deterministic.
- **Retention sweep**: runs once on writer-task startup. Enumerates `<LogsDir>/prism-*.log`, parses the date suffix (regex `^prism-(\d{4}-\d{2}-\d{2})\.log$`), deletes files where `(today - fileDate).Days > RetentionDays`. Non-matching filenames (e.g., `prism.log.bak`, `notes.txt`) are skipped silently. Each `File.Delete` is wrapped in `try/catch (IOException, UnauthorizedAccessException)`; a failure increments `_retentionFailureCount` reported to stderr at shutdown.
- **Flush cadence**: `await FlushAsync()` after every event. A host crash loses at most the in-flight event. The assumed disk class is local SSD or comparable (typical `FlushAsync` ~1ms). On a NAS / AV-scanned drive with 50-200ms flush latency, a sustained debug-flood could fill the 1024-deep channel — the drop counter signal at shutdown surfaces this case. If dogfooding hits the symptom, the flush-batching deferral (§ 11) becomes the fix; v1 accepts the trade.

### 6.2 Field-redaction policy (resolves the spec-§-6.2 carve-out reference)

The file sink redacts by structured-arg field name. Three classes of behavior:

| Class | Behavior | Field names |
|---|---|---|
| **Redacted to `[REDACTED]`** | Top-level structured arg whose key matches `BlockedFieldNames` (case-insensitive) | `subscriberId`, `pat`, `token`, `pendingReviewId`, `threadId`, `replyCommentId`, `login` |
| **Carve-out — explicitly NOT redacted** | Diagnostic value outweighs PII risk for these specific arg names | `body`, `content`, `responseBody`, `ErrorsJson`, `headSha`, `prRef`, message-template `{OriginalFormat}` |
| **Default — passes through unchanged** | Any other arg name | (everything else) |

**The carve-out boundary is by ARG NAME, not by value content.** A `login`-shaped value embedded as a substring inside an `ErrorsJson` arg value is NOT redacted — the slice's structured-arg pass operates on the KV pair's key, not the KV value's contents. PR #55's GitHub error-body delegates emit `body` / `ErrorsJson` arguments that are diagnostically load-bearing and would lose their forensic value if scrubbed. The threat model accepts this: the log file is owned by the same user who runs PRism (`%LOCALAPPDATA%/PRism/logs/` on Windows, default user ACL), and `body` / `ErrorsJson` strings from GitHub do not include the user's PAT (the PAT lives in the OS keychain and never reaches a response body — confirmed via inspection of `GitHubReviewService.cs` and `PrSubmitEndpoints.cs`).

`SensitiveFieldScrubberTests` includes `KeepsBodyField_Unredacted` and `KeepsHeadShaField_Unredacted` as regression nets for this carve-out boundary.

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
- `EmitsSessionStartLine_AsFirstEventInTheFile` *(ADV-9 — operator boundary marker)*
- `EmitsSessionEndLine_AndCounterSummary_OnGracefulShutdown`
- `RedactsPatField_WhenPresentAsStructuredArg`
- `RedactsLoginField_WhenPresentAsStructuredArg` *(new — bundled multi-account-scaffold deferral)*
- `RedactsPendingReviewIdAndThreadIdAndReplyCommentId` *(S5 PR3 deferral closure)*
- `KeepsBodyField_Unredacted` *(regression net for the § 6.2 carve-out)*
- `KeepsHeadShaField_Unredacted`
- `LoginValue_EmbeddedInBodyString_IsNotRedacted_DocumentingTheCarveOut` *(negative test — pins SEC-3 scope boundary explicitly so future contributors don't assume `login`-value protection inside body strings)*
- `WritesExceptionToString_OnIndentedContinuationLines`
- `DropsEvent_DueToBackpressure_IncrementsBackpressureCounter` *(channel full during normal operation)*
- `DropsEvent_DuringShutdown_IncrementsShutdownCounter_NotBackpressure` *(ADV-4 — graceful-shutdown elision counted separately from backpressure drop)*
- `FinalShutdownLine_NamesBothCounters_WhenNonZero`
- `RollsOverFile_AtLocalDateBoundary` *(uses `Func<DateTimeOffset>` clock seam injected via `internals-visible-to`; the seam covers both `FileLogEvent.Timestamp` and the local-date rollover boundary)*
- `RotationDuringDrain_AssignsEventsToFilesByEventLocalDate_NotByDrainTime` *(pins the ADV-10 boundary semantics from § 6.1)*
- `RetentionSweep_DeletesFilesOlderThanRetentionDays`
- `RetentionSweep_KeepsNonMatchingFilenames`
- `RetentionSweep_KeepsFilesAtExactlyRetentionDaysOld` *(boundary test — `>` not `≥`)*
- `Shutdown_FlushesPendingEvents_BeforeStreamClose`
- `IoFailureOnWrite_DoesNotThrow_AndContinuesDraining_AndEmitsOneStderrLine`
- `RecreatesLogsDirectory_IfDeletedAtRuntime` *(see § 12.5)*
- `WriterTask_DoesNotCallILogger_OnAnyFailurePath` *(introspection on a `ListLoggerProvider` records to confirm no recursion)*
- `ZeroArgLoggerMessageDefine_StateHasNoOriginalFormat_FallsBackToFormatter_Unscrubbed` *(ADV-1 — documents the zero-arg case behavior so a future site adding args doesn't silently land in the fallback)*
- `OpenAppendStream_OnLockedDailyFile_IncrementsWriteFailureCount_AndContinues` *(ADV2-4 — pins the second-PRism-process behavior; the lockfile prevents PRism startup but doesn't prevent the file-open attempt; the sink's failure path handles it cleanly)*
- `ValueWhoseToStringThrows_FallsBackToFormatter_AndIncrementsParserFailureCounter` *(ADV2-3 — pins the broad-catch behavior in LogTemplateFormatter when a value's ToString throws)*

### 8.2 `LogTemplateFormatterTests` — focused on the substitution path

- `SimpleNamedPlaceholder_Substitutes`
- `MissingKey_RendersEmptyString` *(updated from "LeavesPlaceholderIntact" — `string.Format` with a null arg renders empty; document the actual behavior)*
- `FormatSpecifier_AppliedToFormattable` *(e.g., `{Count:N0}` on `int 1234` → `1,234`)*
- `AlignmentSpecifier_AppliedAsWidth` *(`{Code,5}` on `"foo"` → `"  foo"`)*
- `EscapedBraces_RendersLiteralBraces`
- `MalformedTemplate_ReturnsTemplateVerbatim_AndDoesNotThrow`
- `NullValue_RendersAsEmptyString`
- `MultipleOccurrencesOfSameName_AllSubstituted` *(template `"a={X} b={X}"` with one X arg)*
- `ValueContainingPlaceholderShape_DoesNotRecurseIntoSecondSubstitution` *(ADV-3 — value `"{login}"` literal in arg position 1 does NOT pick up arg `login`'s value via second-pass scan; pins single-pass `string.Format` invariant)*

(The `RepeatedKVKeyInState_LastValueWins_NoArgumentException` test exercises `FileLogger.Log<TState>`'s manual `dict[k] = v` loop — the last-wins behavior is at the file-sink layer, NOT at the formatter layer — so it lives in § 8.1 alongside the other `FileLoggerProvider` tests, not here.)

### 8.3 `FileLoggerIntegrationTests` — `WebApplicationFactory<Program>`-driven

These tests **explicitly opt in** to file-sink registration via `factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<ILoggerProvider>(sp => new FileLoggerProvider(testLogsDir))))` since `Program.cs` gates the production registration on `!IsEnvironment("Test")` (see § 9). Each test uses `Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString())` as its DataDir to sidestep CI temp-dir collisions (ADV-6 mitigation).

- `EndToEnd_StructuredLogWithPatField_ProducesFileWithRedactedValue`:
  spins up the host with a temp `DataDir`, fires a known structured-log event with `pat: "ghp_secret_test"` (via a tiny test-only endpoint or via an existing endpoint that touches the structured-log code path), asserts (i) the expected file path exists, (ii) the literal `ghp_secret_test` does NOT appear in the file, (iii) `[REDACTED]` does appear, (iv) the timestamp is parseable as UTC ISO 8601, (v) the session-start marker line is present. **This is the load-bearing regression test for the slice.**
- `EndToEnd_HostShutdown_FlushesAllInFlightEvents`:
  fires N events, triggers `IHostApplicationLifetime.StopApplication`, asserts all N appear in the file (along with the session-end summary).

### 8.4 `SensitiveFieldScrubberTests` — split + extension

- Add tests covering the new `ScrubFieldName(name, value)` method (redaction-only): all existing redaction cases assert via `ScrubFieldName` AND `Scrub` (for back-compat).
- `ScrubFieldName_DoesNotTruncateLongStrings` — explicit regression test confirming the new method does NOT carry the 1024-char truncation from `Scrub`.
- `Scrub_StillTruncatesLongStrings_ForBackCompat` — existing behavior preserved for direct callers (`PrDraftsDiscardAllEndpoint.cs:97`).
- Add `[InlineData("login")]` and `[InlineData("Login")]` to the existing redaction theory. Rename `Redacts_submit_pipeline_field_names` to `Redacts_blocked_field_names` to reflect the broader set.

Total new tests: ~30 new test cases + 2 theory data rows. The count grew from the original ~24 because of the four substantive correctness fixes from ce-doc-review (counter split, rotation boundary semantics, formatter recursion guard, scrubber API split).

## 9. Wiring change in `Program.cs`

**Single change:** `AddPRismFileLogger` runs **pre-Build** with the test-environment gate inside the extension method itself. The pre-Build shape is the documented path because (a) `Microsoft.Extensions.Logging.LoggerFactory.AddProvider` calls invoked AFTER `Build()` do not retroactively propagate to `ILogger<T>` instances already resolved during DI composition — startup-time log sites would silently bypass the file sink; (b) `LoggerFactory.Dispose()` invokes provider `Dispose()` synchronously, not `DisposeAsync()`, so a post-Build-injected provider loses the async-drain contract the rest of the spec depends on. The pre-Build singleton registration delivers both: the provider is in every `Logger<T>`'s initial `MessageLogger[]`, and the DI container holds the singleton as an `IAsyncDisposable` whose `DisposeAsync` runs during host teardown.

The extension method gates internally on the environment so callers don't have to duplicate the check:

```csharp
public static ILoggingBuilder AddPRismFileLogger(this ILoggingBuilder builder, string dataDir, IHostEnvironment env)
{
    if (env.IsEnvironment("Test")) return builder;   // Test-host carve-out (see § 9.1)

    var logsDir = Path.Combine(dataDir, "logs");
    builder.Services.AddSingleton<FileLoggerProvider>(_ => new FileLoggerProvider(logsDir));
    builder.Services.AddSingleton<ILoggerProvider>(sp => sp.GetRequiredService<FileLoggerProvider>());
    return builder;
}
```

Call site in `Program.cs`, after `dataDir` resolution (`PRism.Web/Program.cs:39`) and BEFORE `builder.Build()`:

```csharp
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

builder.Logging.AddPRismFileLogger(dataDir, builder.Environment);  // <-- new, pre-Build

builder.Services.AddPrismCore(dataDir);
// ... rest unchanged.
```

**Note on lockfile ordering.** The existing `LockfileManager.Acquire` call happens post-Build inside the `if (!isTest)` block (`PRism.Web/Program.cs:116`). After this change the file sink's `FileStream` opens BEFORE the lockfile acquires (because the writer task starts in `FileLoggerProvider`'s constructor, which fires during DI singleton resolution at first `ILogger<T>` resolution or at host startup — earlier than `Program.cs:116`). The "single-writer invariant" the spec leans on at § 10 is therefore not enforced by the lockfile FOR the file sink specifically; it's enforced by the OS-level `FileShare.Read` semantics (a second PRism process opening the same daily file gets `IOException`, increments `_writeFailureCount`, surfaces one stderr line). The lockfile prevents the second process from completing its own startup but doesn't prevent the file-open attempt. This is acceptable: the second process's file sink is a no-op (writes fail, drain on shutdown), and the lockfile mechanism still keeps the rest of PRism off the keyboard. The test `OpenAppendStream_OnLockedDailyFile_IncrementsWriteFailureCount_AndContinues` (added to § 8.1) pins this behavior.

No other production-code touchpoints. The Console + Debug providers stay registered (`WebApplication.CreateBuilder` adds them by default); the file sink is additive.

### 9.1 Test-host implications

`WebApplicationFactory<Program>`-based xUnit tests **do not inherit the file sink** because the extension method's `env.IsEnvironment("Test")` short-circuit fires before any registration. 111 test factories × 31 test files × parallel xUnit workers no longer spin up writer tasks against temp DataDirs. The integration tests in § 8.3 explicitly opt in via `WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<ILoggerProvider>(sp => new FileLoggerProvider(testLogsDir))))` with a per-test `Guid`-named temp DataDir — bypassing the extension method entirely.

Playwright projects (`PRISM_E2E_FAKE_REVIEW=1` / `PRISM_E2E_REAL_INJECT=1`) launch the real binary with `ASPNETCORE_ENVIRONMENT=Test` and therefore lose the file sink. If a real-flow incident needs backend log capture, the deferral list (§ 11) tracks the env-var hook (`PRism__FileSink__ForceEnable=1`) as the fix — small one-line extension to the gate when needed.

## 10. Architectural invariants this slice maintains

- **No new third-party dependencies.** Uses only `Microsoft.Extensions.Logging`, `System.Threading.Channels`, `System.IO` — all in the BCL.
- **`AtomicFileMove` discipline preserved for state writes.** Logs are append-only and not load-bearing — they don't use the atomic-rename primitive. The `Storage/` namespace stays focused on state.
- **`SensitiveFieldScrubber` location unchanged** (`PRism.Web/Logging/`). Slice expands its blocklist by one entry; doesn't move it to `PRism.Core`.
- **No recursion through ILogger from the sink's failure paths.** Writer task uses `Console.Error.WriteLine` exclusively for self-diagnostics.
- **Source-gen `LoggerMessage.Define` continues to work unchanged.** The sink interprets `IReadOnlyList<KV>` projection (which source-gen output supports); no change to call sites.
- **Lockfile + single-process invariant.** `LockfileManager.Acquire` already guarantees one PRism.Web per dataDir; the writer's `FileShare.Read` is safe.

## 11. Out of scope (deferrals this slice ships)

Each lands as an entry in [`2026-05-18-on-disk-log-writer-deferrals.md`](2026-05-18-on-disk-log-writer-deferrals.md) (created alongside this spec). The v1 shape is expected to be the permanent shape unless a concrete failure pulls one forward — the list exists for visibility, not as an implicit roadmap commitment.

- **[Defer] Factory-level `ILogger`-wrapping decorator for universal redaction across Console + Debug + future providers.** Revised reasoning from S3 PR5: file sink covers the load-bearing post-mortem case; universal decorator requires ~200 LOC of template-substitution machinery and protects against speculative leak vectors for a PoC.
- **[Defer] Serilog (or NLog) with a destructuring policy / filter enricher.** Considered in § 1.2 alternative (b). Rejected for now on dependency-discipline grounds. Revisit if the in-process sink's maintenance trade flips (e.g., size-based rotation + retention + NDJSON all land together, at which point Serilog's mature feature set may dominate the hand-written version).
- **[Defer] `run.ps1` `Tee-Object` to file (zero in-process code).** Considered in § 1.2 alternative (c). Rejected because non-`run.ps1` launches (`dotnet run`, IDE, Playwright, CI) bypass it and console-formatter output strips structured args.
- **[Defer] Size-based rotation / total-disk-cap retention.** Date-based 14-day retention is sufficient for single-user PoC throughput. Revisit if a debug-flood day occurs.
- **[Defer] NDJSON / structured machine-parseable format.** Plain text is gh-issue-friendly; revisit when a triage tool needs structured input.
- **[Defer] `BeginScope` dispatch into the file sink.** v1 returns `NullScope.Instance`. Revisit when a PRism log site adds scope context that downstream readers need.
- **[Defer] Regex-based PAT-shape scrub of exception messages and stack traces.** Field-name redaction only. Revisit if an exception-message leak is reported in a real incident.
- **[Defer] Hot-reload of file-sink constants (`RetentionDays`, `ChannelCapacity`).** v1 uses compile-time constants in `FileLoggerConstants`. Revisit if a deployment scenario emerges that warrants dynamic config.
- **[Defer] Flush-batching for throughput.** v1 flushes per event. Revisit if a debug-flood proves the eager-flush cost dominates.
- **[Defer] Playwright env-var hook for opt-in file-sink under Test environment.** Real-flow e2e diagnostics would benefit from on-disk evidence; v1's `!isTest` gate excludes the sink unconditionally. Revisit if a real-flow incident requires backend log capture from a Playwright run.
- **[Defer] Dedicated stderr-replacement self-diagnostic file.** v1 uses `Console.Error.WriteLine` for writer-task self-diagnostics; the recursion-safety claim depends on no provider capturing stderr. Revisit if a future provider intercepts stderr.

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

If a user manually deletes the logs directory while the host runs, the next stream open would fail. Fix: `OpenAppendStream(DateOnly d)` calls `Directory.CreateDirectory(_logsDir)` before opening the FileStream (idempotent; cheap). The rotation path therefore self-heals against a manually-deleted directory. Test `RecreatesLogsDirectory_IfDeletedAtRuntime` pins this (listed in § 8.1).

### 12.6 PR #55 log delegates touch live identifiers (acknowledged gap with the `login` blocklist addition)

PR #55 added `s_graphqlSubmitFailed`, `s_graphqlReadFailed`, `s_graphqlTransportFailed`, `s_graphqlSubmitNoData` in `PRism.GitHub/GitHubReviewService*.cs`. These take an error-body string truncated to 1024 chars and emit it as a `body`, `responseBody`, or `ErrorsJson` structured arg. The body may contain GitHub-supplied identifiers (PR numbers, commit SHAs, comment IDs, and — relevant after this slice — user `login` values embedded in error messages like `"User X is not authorized"`).

**The `login` blocklist addition (§ 4.7) does NOT cover this case.** Field-name redaction operates on the top-level arg key (`login`), not on the JSON-value's contents inside a `body` / `ErrorsJson` arg. A GitHub error response that includes a username inside its `message` or `path` field lands on disk verbatim. Per § 6.2's carve-out table this is an accepted trade — `body`/`ErrorsJson` redaction would mangle the diagnostic value the delegates exist for. The slice's `login` redaction is preventive against a future log site that emits `login` as a top-level arg; embedded values are a separate concern with a separate (deferred) fix path.

The companion exception path: `exception?.ToString()` in `FileLogEvent` captures `Exception.Message` and `StackTrace` verbatim. `HttpRequestException` thrown at `GitHubReviewService.cs:759-770` interpolates up to 512 chars of the GitHub response body directly into `Message`. The on-disk log therefore contains the body twice: once via the structured `body`/`responseBody` arg (truncated to 1024 chars), once via the exception chain in `ExceptionString` (truncated to 512 chars). Both paths are out of scope for field-name scrub. The discipline ("never put a PAT in an exception message") remains the user-controlled mitigation; GitHub response bodies have been verified not to contain the request's PAT (confirmed by inspection of `GitHubReviewService.cs` and `PostGraphQLAsync` — the Authorization header is never echoed back in 401 / 403 responses).

The carve-out boundary is documented in § 6.2; the regex-based exception-message scrub remains the deferred fix path (§ 11).

## 13. Open questions

None at design time. All substantive questions were resolved during the brainstorm pass; mechanical defaults (UTF-8, append mode, `FileShare.Read`, retention 14 days, channel capacity 1024) are recorded with their reasoning in § 6.

## 14. Acceptance

This slice is done when:

1. `<dataDir>/logs/prism-YYYY-MM-DD.log` exists and contains structured log lines after a normal `run.ps1` session.
2. A log line that would have carried a PAT value contains `[REDACTED]` and not the PAT.
3. The same for `login`, `pendingReviewId`, `threadId`, `replyCommentId` when each appears as a top-level structured arg.
4. The 14-day retention sweep removes stale files on startup.
5. Date rollover at local midnight starts a new file; events with pre-midnight timestamps drained after midnight land in yesterday's file per § 6.1.
6. Host shutdown drains pending events; no events are lost on graceful stop. Backpressure drops and shutdown-elisions are reported as separate counters in the session-end summary.
7. A session-start marker line appears as the first event in each file, enabling operators to bound a post-mortem to one session via `grep`.
8. A disk-full or I/O-failure scenario does not crash the host.
9. `WebApplicationFactory<Program>`-based xUnit tests do not inherit the file sink (production-gate via `!isTest`); the § 8.3 integration tests opt in explicitly via DI override with `Guid`-named temp DataDirs.
10. `SensitiveFieldScrubber.ScrubFieldName` (redaction-only) is the path the file sink uses; the existing combined `Scrub` (with 1024-char truncation) remains for direct callers.
11. All ~30 new tests + 2 theory rows pass.
12. The integration test `EndToEnd_StructuredLogWithPatField_ProducesFileWithRedactedValue` is the load-bearing assertion that the slice's primary contract holds end-to-end.
