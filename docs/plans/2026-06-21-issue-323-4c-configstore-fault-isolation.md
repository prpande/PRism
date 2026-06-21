# ConfigStore Subscriber-Fault Isolation (#323 item 4c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ConfigStore.Changed` dispatch fault-isolating per-handler (mirroring the shipped `ReviewEventBus.Publish`), surface a swallowed subscriber fault via a new optional `ILogger<ConfigStore>`, absorb a subscriber-thrown `OperationCanceledException` on the fire-and-forget watcher path, and extract the `Task.Delay(100)` debounce literal to a named constant.

**Architecture:** Two tasks. Task 1 rewrites `RaiseChanged()` to walk `Changed.GetInvocationList()` with per-handler try/catch (rethrow `OperationCanceledException`, log + continue on the rest), adds the optional-logger ctor seam (`NullLogger` default), and wires the real logger through DI. Task 2 widens `HandleFileChangedAsync`'s catch filter to absorb the now-rethrowable OCE on the no-cancellation watcher path and extracts the debounce constant. All five live `Changed` subscribers are throw-safe today, so this is structural hardening + parity with #323 item 1 — there is no live crash being fixed.

**Tech Stack:** C# / .NET 10, `PRism.Core`; xUnit + FluentAssertions; `Microsoft.Extensions.Logging` (already referenced by `PRism.Core`).

## Global Constraints

- Build is `TreatWarningsAsErrors=true` + `AnalysisMode=AllEnabledByDefault` (Directory.Build.props). The `catch (Exception ex)` in `RaiseChanged` MUST be wrapped in `#pragma warning disable CA1031` / `restore CA1031`, exactly as `ReviewEventBus.Publish` does.
- The fault-isolation **mechanism** mirrors `PRism.Core/Events/ReviewEventBus.cs` (`Publish`): capture-to-local, `GetInvocationList()`, per-handler try/catch, `catch (OperationCanceledException) { throw; }`, log + continue, static `LoggerMessage.Define` field. One deliberate difference: `ConfigStore.Changed` is a single fixed event type, so it uses the zero-arg `LoggerMessage.Define` (no `{EventType}` placeholder) — do NOT add an event-type token (it would log a constant).
- The new ctor param is **optional** (`ILogger<ConfigStore>? log = null` → `NullLogger<ConfigStore>.Instance`). Every existing `new ConfigStore(dir)` test site (70+, all under `tests/PRism.Core.Tests/Config` and `tests/PRism.Core.Tests/Auth`) MUST keep compiling untouched.
- No wire/DTO/UI/frontend change. No on-disk format change. The only intended behavioral change is the synchronous-path 500→200 swallow on a subscriber fault (currently unreachable; explicitly signed off in the spec AC).
- Do NOT touch the three existing `LastLoadError`-only silent catches (`ReadFromDiskAsync`, `TryStartWatcher`, and the IO/JSON arm of `HandleFileChangedAsync`) beyond the one OCE-filter widening in Task 2 — broader catch-logging is a separate #338 concern.
- Gated B2: drive to green; HOLD for owner merge. PR body uses `Closes #323` (4c is the last item); `#338` referenced bare (no closing keyword). Commit messages use bare `#323` refs only — no `close/fix/resolve` keyword adjacency in any commit.
- Spec: `docs/specs/2026-06-21-issue-323-4c-configstore-fault-isolation-design.md`.

---

### Task 1: Fault-isolating `RaiseChanged()` + `ILogger<ConfigStore>` seam + DI wiring

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` (add usings; add `_log` field + optional ctor param; rewrite `RaiseChanged()`; add `s_subscriberFaulted` field)
- Modify: `PRism.Core/ServiceCollectionExtensions.cs:53` (DI factory) and `:158` (`CreateConfigStore` signature)
- Create: `tests/PRism.Core.Tests/Config/ConfigStoreChangedFaultIsolationTests.cs`

**Interfaces:**
- Consumes: `event EventHandler<ConfigChangedEventArgs>? Changed` (existing); `AppConfig Current`, `Exception? LastLoadError`, `Task PatchAsync(IReadOnlyDictionary<string, object?>, CancellationToken)` (existing); `TempDataDir` (`.Path`) from `PRism.Core.Tests.TestHelpers`. (Tests deliberately skip `InitAsync` — see the test-class note — to keep the `FileSystemWatcher` off.)
- Produces: `ConfigStore(string dataDir, ILogger<ConfigStore>? log = null)` — the second param is optional; all existing one-arg call sites are unaffected. `RaiseChanged()` becomes fault-isolating for ALL four call sites (`PatchAsync`, `SetDefaultAccountLoginAsync`, `RecordAiConsentAsync`, `HandleFileChangedAsync`).

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Config/ConfigStoreChangedFaultIsolationTests.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

// These tests deliberately do NOT call InitAsync, so no FileSystemWatcher is started. A live
// watcher would fire a second, debounced RaiseChanged ~100ms after each PatchAsync disk write —
// doubling the logged-fault count (test 2's ContainSingle) and racing LastLoadError (test 4).
// Starting from AppConfig.Default is a sufficient baseline for every assertion here.
public sealed class ConfigStoreChangedFaultIsolationTests
{
    [Fact]
    public async Task RaiseChanged_isolates_a_throwing_subscriber_and_still_runs_siblings_and_persists()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);

        var secondRan = false;
        store.Changed += (_, _) => throw new InvalidOperationException("subscriber boom");
        store.Changed += (_, _) => secondRan = true;

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        await act.Should().NotThrowAsync("a faulting subscriber must not propagate into the writer");
        secondRan.Should().BeTrue("a faulting subscriber must not abort dispatch to the rest");
        store.Current.Ui.Theme.Should().Be("dark", "the config write persisted despite the fault");
    }

    [Fact]
    public async Task RaiseChanged_logs_a_subscriber_fault_at_Error_with_the_event_id()
    {
        using var dir = new TempDataDir();
        var logger = new CapturingLogger();
        using var store = new ConfigStore(dir.Path, logger);

        var boom = new InvalidOperationException("subscriber boom");
        store.Changed += (_, _) => throw boom;

        await store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        logger.Entries.Should().ContainSingle(e =>
            e.Level == LogLevel.Error
            && e.EventId.Name == "ConfigStoreSubscriberFaulted"
            && e.Exception == boom);
    }

    [Fact]
    public async Task RaiseChanged_does_not_swallow_OperationCanceledException_on_the_synchronous_path()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);

        store.Changed += (_, _) => throw new OperationCanceledException();

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        await act.Should().ThrowAsync<OperationCanceledException>(
            "cooperative cancellation is not swallowed by fault isolation");
    }

    private sealed class CapturingLogger : ILogger<ConfigStore>
    {
        public List<(LogLevel Level, EventId EventId, Exception? Exception, string Message)> Entries { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            Entries.Add((logLevel, eventId, exception, formatter(state, exception)));
        }
        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();
            public void Dispose() { }
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStoreChangedFaultIsolationTests"`
Expected: BUILD FAIL — `CS1729` / `CS1503` on `new ConfigStore(dir.Path, logger)` (the two-arg ctor does not exist yet). This is the RED (compile-error form). The behavioral RED behind it: under the current `Changed?.Invoke`, test 1 would throw `InvalidOperationException` out of `PatchAsync` and test 2 has no logger to capture.

- [ ] **Step 3: Add the logger seam, rewrite `RaiseChanged()`, wire DI**

In `PRism.Core/Config/ConfigStore.cs`, add the usings at the top of the file (after the existing `using` lines):

```csharp
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
```

Add the `_log` field next to the other private fields (near `private readonly string _path;`):

```csharp
private readonly ILogger _log;
```

Replace the constructor:

```csharp
public ConfigStore(string dataDir)
{
    _path = Path.Combine(dataDir, "config.json");
}
```

with:

```csharp
public ConfigStore(string dataDir, ILogger<ConfigStore>? log = null)
{
    _path = Path.Combine(dataDir, "config.json");
    _log  = log ?? NullLogger<ConfigStore>.Instance;
}
```

Replace the one-line `RaiseChanged`:

```csharp
private void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(_current));
```

with the fault-isolating form + the static log-message field:

```csharp
private void RaiseChanged()
{
    // Per-handler fault isolation (#323 item 4c), mirroring ReviewEventBus.Publish: one throwing
    // subscriber must not abort dispatch to the remaining subscribers, nor propagate into the
    // publisher. Critical because HandleFileChangedAsync invokes this fire-and-forget — an escaping
    // exception there becomes an unobserved task exception. OperationCanceledException is rethrown so
    // cooperative cancellation still aborts dispatch (the watcher path absorbs it; see
    // HandleFileChangedAsync). Single fixed event type, so the log message omits the bus's
    // {EventType} placeholder by design.
    var handlers = Changed;
    if (handlers is null) return;
    var args = new ConfigChangedEventArgs(_current);
    foreach (var d in handlers.GetInvocationList())
    {
        try
        {
            ((EventHandler<ConfigChangedEventArgs>)d)(this, args);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // a faulting subscriber is isolated and logged, not propagated
        catch (Exception ex)
#pragma warning restore CA1031
        {
            s_subscriberFaulted(_log, ex);
        }
    }
}

private static readonly Action<ILogger, Exception?> s_subscriberFaulted =
    LoggerMessage.Define(LogLevel.Error,
        new EventId(1, "ConfigStoreSubscriberFaulted"),
        "A ConfigStore.Changed subscriber threw; isolating the fault and continuing dispatch");
```

In `PRism.Core/ServiceCollectionExtensions.cs`, replace the registration at `:53`:

```csharp
services.AddSingleton<IConfigStore>(_ => CreateConfigStore(dataDir));
```

with:

```csharp
services.AddSingleton<IConfigStore>(sp =>
    CreateConfigStore(dataDir, sp.GetRequiredService<ILogger<ConfigStore>>()));
```

and replace `CreateConfigStore` (around `:158`):

```csharp
private static ConfigStore CreateConfigStore(string dataDir)
{
    var store = new ConfigStore(dataDir);
    store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
    return store;
}
```

with:

```csharp
private static ConfigStore CreateConfigStore(string dataDir, ILogger<ConfigStore> log)
{
    var store = new ConfigStore(dataDir, log);
    store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
    return store;
}
```

Keep the existing `[SuppressMessage("Performance", "CA1849:...")]` attribute on `CreateConfigStore` unchanged. `ServiceCollectionExtensions.cs` already uses `ILogger<…>` from `sp` in sibling factories, so `using Microsoft.Extensions.Logging;` is already present — confirm it is; add it if missing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStoreChangedFaultIsolationTests"`
Expected: PASS — 3/3. (DI wiring has no dedicated unit test; it is verified by the build and the existing container-boot tests. The logger-flows-through behavior is covered by test 2 via direct ctor injection.)

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs PRism.Core/ServiceCollectionExtensions.cs tests/PRism.Core.Tests/Config/ConfigStoreChangedFaultIsolationTests.cs
git commit -m "refactor(core): isolate ConfigStore.Changed subscriber faults + add ILogger seam

RaiseChanged now walks GetInvocationList with per-handler try/catch (rethrow OCE,
log+continue), mirroring ReviewEventBus.Publish. Optional ILogger<ConfigStore>
ctor seam (NullLogger default) surfaces a swallowed subscriber fault; DI passes the
real logger. Protects all four RaiseChanged call sites. Refs #323."
```

---

### Task 2: Absorb subscriber OCE on the watcher path + extract the debounce constant

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` (`HandleFileChangedAsync`: widen catch filter, make it `internal`; add `FileChangeDebounceMilliseconds` const)
- Modify: `tests/PRism.Core.Tests/Config/ConfigStoreChangedFaultIsolationTests.cs` (append test 4)

**Interfaces:**
- Consumes: the fault-isolating `RaiseChanged()` from Task 1 (it rethrows `OperationCanceledException`).
- Produces: `internal async Task HandleFileChangedAsync()` — visibility widened from `private` so the test can invoke the fire-and-forget path deterministically. The FSW-trigger alternative (file-write + `Task.Delay` drain, as in `ConfigStoreMigrationTests`) is deliberately **rejected**: starting the live watcher is the exact flake vector these tests avoid (a debounced reload would fire a second `RaiseChanged`), so direct invocation is the only deterministic seam — which is what the `internal` widening buys. IVT to `PRism.Core.Tests` already exists (precedent: `LockfileManager`'s test seam). `private const int FileChangeDebounceMilliseconds = 100;`.

- [ ] **Step 1: Write the failing test**

Append to `tests/PRism.Core.Tests/Config/ConfigStoreChangedFaultIsolationTests.cs`, inside the class, after the third `[Fact]`:

```csharp
    [Fact]
    public async Task HandleFileChangedAsync_absorbs_a_subscriber_OperationCanceledException_into_LastLoadError()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);

        store.Changed += (_, _) => throw new OperationCanceledException();

        // Invoke the fire-and-forget watcher path directly (internal via InternalsVisibleTo) so the
        // assertion is deterministic — no FileSystemWatcher race. If the OCE were not absorbed it would
        // escape the fire-and-forget task as an unobserved exception; awaiting it here surfaces the leak.
        Func<Task> act = () => store.HandleFileChangedAsync();

        await act.Should().NotThrowAsync(
            "a subscriber OCE on the no-cancellation watcher path must be absorbed, not leaked");
        store.LastLoadError.Should().BeOfType<OperationCanceledException>(
            "the absorbed subscriber fault is recorded in LastLoadError");
    }
```

- [ ] **Step 2: Run the test to verify it fails (compile)**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~HandleFileChangedAsync_absorbs"`
Expected: BUILD FAIL — `CS0122` (`HandleFileChangedAsync` is inaccessible due to its protection level). This is the first RED.

- [ ] **Step 3: Make `HandleFileChangedAsync` internal (minimal change to compile)**

In `PRism.Core/Config/ConfigStore.cs`, change the signature only:

```csharp
private async Task HandleFileChangedAsync()
```

to:

```csharp
internal async Task HandleFileChangedAsync()
```

Leave the body unchanged for now.

- [ ] **Step 4: Run the test to verify it fails (behavioral)**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~HandleFileChangedAsync_absorbs"`
Expected: FAIL — the test throws `OperationCanceledException` at the `await act` point. `RaiseChanged` (Task 1) rethrows the subscriber OCE, and `HandleFileChangedAsync`'s current catch filter (`IOException or UnauthorizedAccessException or JsonException or ObjectDisposedException`) does NOT match it, so it escapes. This is the meaningful behavioral RED — exactly the unobserved-task-exception leak 4c closes.

- [ ] **Step 5: Widen the catch filter and extract the debounce constant**

In `PRism.Core/Config/ConfigStore.cs`, add the constant next to the `FileSystemWatcher? _watcher;` field:

```csharp
// Debounce window for FileSystemWatcher.Changed bursts (an editor save fires several events).
private const int FileChangeDebounceMilliseconds = 100;
```

In `HandleFileChangedAsync`, replace the debounce line:

```csharp
await Task.Delay(100).ConfigureAwait(false); // debounce save flurry
```

with:

```csharp
await Task.Delay(FileChangeDebounceMilliseconds).ConfigureAwait(false); // debounce save flurry
```

and widen the catch filter from:

```csharp
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ObjectDisposedException)
{
    LastLoadError = ex;
}
```

to:

```csharp
// OperationCanceledException is added because RaiseChanged rethrows a subscriber-thrown OCE
// (sibling parity with ReviewEventBus). This path is fire-and-forget with CancellationToken.None
// — there is no real cancellation in play — so a subscriber OCE is absorbed here rather than
// leaked as an unobserved task exception. Synchronous callers still see OCE propagate.
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
    or JsonException or ObjectDisposedException or OperationCanceledException)
{
    LastLoadError = ex;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStoreChangedFaultIsolationTests"`
Expected: PASS — 4/4 (the three from Task 1 plus the new watcher-path test).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStoreChangedFaultIsolationTests.cs
git commit -m "refactor(core): absorb subscriber OCE on the ConfigStore watcher path + name the debounce constant

HandleFileChangedAsync now absorbs a subscriber-thrown OperationCanceledException
(which RaiseChanged rethrows) into LastLoadError instead of leaking it as an
unobserved task exception on the fire-and-forget path; widened to internal so the
path is testable deterministically. Task.Delay(100) -> FileChangeDebounceMilliseconds
(also a #338 magic-literal item). Refs #323, #338."
```

---

## Final verification (after both tasks, before PR)

Run the full pre-push checklist from `.ai/docs/development-process.md`. At minimum:

- Release build: `dotnet build -c Release` → 0 warnings, 0 errors (TWAE proves CA1031 pragma + analyzer-clean).
- Full suite: `dotnet test --settings .runsettings` → green (the 2 pre-existing posix/manual skips are not failures).

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- ILogger seam (§1) → Task 1 Step 3.
- `RaiseChanged` per-handler isolation (§2) → Task 1 Step 3; tests 1–3 (Task 1 Step 1).
- OCE absorption on the watcher path (§3) → Task 2 Steps 3/5; test 4 (Task 2 Step 1).
- Debounce constant (§4) → Task 2 Step 5.
- DI wiring (§5) → Task 1 Step 3.
- Scope boundary (no broader catch-logging) → encoded in Global Constraints; no task touches the other catches.
- AC "synchronous 500→200 signed off" → test 1 asserts the write succeeds despite a fault; the OCE exception to that rule is test 3.

**2. Placeholder scan** — no TBD/TODO; every code step shows complete code; every run step has an exact command + expected result.

**3. Type consistency** — `ConfigStore(string, ILogger<ConfigStore>?)`, `s_subscriberFaulted` (2-arg `Action<ILogger, Exception?>` ← zero-arg `LoggerMessage.Define`), `FileChangeDebounceMilliseconds`, `internal HandleFileChangedAsync`, `EventId(1, "ConfigStoreSubscriberFaulted")` are used identically wherever they appear across both tasks and the tests.

**4. Commit-message format** — both task commits use a bare type/scope (`refactor(core):`) with `Refs #323` only; no `close/fix/resolve #323` adjacency in any commit (the conventional `fix(#N):` scope auto-closes — see [[github-conventional-fix-scope-autocloses]]). The single close trigger is `Closes #323` in the PR body. `#338` is referenced bare.

**5. Test determinism** — all four tests start from `AppConfig.Default` and do not call `InitAsync`, so no `FileSystemWatcher` runs; this removes the debounced-second-dispatch flake vector (scope-guardian round 1) that would otherwise double test 2's log count and race test 4's `LastLoadError`.
