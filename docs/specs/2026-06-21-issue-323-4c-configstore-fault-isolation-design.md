# #323 item 4c — ConfigStore subscriber-fault isolation + debounce constant

**Issue:** #323 item 4c (the final open item). Related: #338 (the magic-literal is one checklist line there).
**Classification:** gated B2 — touches the config hot-reload path and adds a DI dependency. Drive to green; hold for owner merge.
**Closes #323** — 4c is the last remaining item; items 1, 2, 3a/3b/3c, 4a, 4b already shipped.

## Summary

`ConfigStore.HandleFileChangedAsync` is invoked fire-and-forget (`_ = HandleFileChangedAsync()` at the `FileSystemWatcher.Changed` handler). It calls `RaiseChanged()` — which fans out to every `Changed` subscriber — **inside** a `try` whose exception filter only matches `IOException`, `UnauthorizedAccessException`, `JsonException`, and `ObjectDisposedException`. A subscriber that throws anything **outside** that set escapes the fire-and-forget task and becomes an **unobserved task exception** (surfaced on the finalizer thread via `TaskScheduler.UnobservedTaskException`, lost or process-fatal depending on host config).

Item 4c closes this structurally and removes the `Task.Delay(100)` magic debounce literal.

## Reachability — honest framing

This is **currently unreachable, structurally open.** All five live `Changed` subscribers are throw-safe today:

- `ServiceCollectionExtensions.cs:58/66/73` — three AI-state setters (`state.Mode = …`, `state.Set(…)`), reading backfilled-non-null config.
- `PrDetailLoader.OnConfigChanged` → `InvalidateAll()` — `Interlocked.Increment` + `.Clear()` on concurrent collections.
- `InboxRefreshOrchestrator.OnConfigChanged` — synchronous `Interlocked.Exchange`/CAS, then a fire-and-forget refresh poke.

So there is **no live crash to fix.** The value is:

1. **Structural hardening** — any *future* subscriber that throws synchronously (or a backfill regression that lets `args.Config.Ui.Ai` go null) would leak as an unobserved task exception specifically on the watcher path. The synchronous API paths (`PatchAsync` etc.) would instead surface it to the request as a 500 — a different, observable failure — so the watcher path is the dangerous one.
2. **Parity with the already-shipped item 1** — `ReviewEventBus.Publish` already does per-handler fault isolation (#323 item 1). `ConfigStore.Changed` is the sibling event dispatcher and should isolate subscriber faults the same way. (Parity is on the isolation *mechanism*, not byte-for-byte — see the logging-style note in §2 for the one deliberate difference.)
3. **#338** — the `Task.Delay(100)` literal is an explicit #338 "magic literals → named constants" checklist item.

The "unreachable today" fact argues *for* fixing at the dispatch primitive: there is no surgical bug to confine, so the only real payoff is structural, and isolating at `RaiseChanged()` is what actually deletes the class.

## Design

### 1. ILogger seam

Add an optional logger, mirroring `ReviewEventBus` and `InboxRefreshOrchestrator`:

```csharp
private readonly ILogger _log;

public ConfigStore(string dataDir, ILogger<ConfigStore>? log = null)
{
    _path = Path.Combine(dataDir, "config.json");
    _log  = log ?? NullLogger<ConfigStore>.Instance;
}
```

The optional param defaulting to `NullLogger<ConfigStore>.Instance` keeps every existing `new ConfigStore(dir)` test call site (70+, all under `tests/PRism.Core.Tests/Config` and `tests/PRism.Core.Tests/Auth`; `PRism.Web.Tests` has none) compiling and behaving identically — no test churn.

New usings: `Microsoft.Extensions.Logging`, `Microsoft.Extensions.Logging.Abstractions`.

### 2. `RaiseChanged()` — per-handler fault isolation

Current:

```csharp
private void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(_current));
```

New (near-verbatim mirror of `ReviewEventBus.Publish`):

```csharp
private void RaiseChanged()
{
    // Per-handler fault isolation (#323 item 4c), mirroring ReviewEventBus.Publish: one
    // throwing subscriber must not abort dispatch to the remaining subscribers, nor propagate
    // into the publisher. This is critical because HandleFileChangedAsync invokes RaiseChanged
    // fire-and-forget — an escaping exception there becomes an unobserved task exception.
    // OperationCanceledException is rethrown so cooperative cancellation still aborts dispatch.
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

`Changed` is captured to a local before the null check + invoke (standard event-race guard).

This protects **all four** call sites uniformly: `PatchAsync`, `SetDefaultAccountLoginAsync`, `RecordAiConsentAsync`, and `HandleFileChangedAsync`.

**Logging style:** mirrors `ReviewEventBus`'s static `LoggerMessage.Define` field idiom. One deliberate difference: the bus uses `Define<string>` with a `{EventType}` placeholder because it is generic over many event types; `ConfigStore.Changed` is a *single* fixed event type, so the message uses the zero-arg `LoggerMessage.Define` (no placeholder) — a `{EventType}` token here would always log the same constant and add no diagnostic value. The parity that matters (per-handler try/catch, OCE-rethrow, log+continue) is identical. #338 separately tracks converging all logging onto the nested-`Log` source generator; that convergence is out of scope here.

### 3. Completeness — absorb OCE on the fire-and-forget watcher path

Because `RaiseChanged()` rethrows `OperationCanceledException` (sibling parity with the bus), and `HandleFileChangedAsync` runs fire-and-forget with `CancellationToken.None` (no real cancellation token in play), a subscriber-thrown OCE would re-leak as an unobserved task exception — re-opening the exact hole 4c closes. So `OperationCanceledException` is added to `HandleFileChangedAsync`'s existing catch filter:

```csharp
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
    or JsonException or ObjectDisposedException or OperationCanceledException)
{
    LastLoadError = ex;
}
```

Synchronous callers (`PatchAsync` etc.) still see OCE propagate (cancellation contract preserved); the watcher path absorbs it into `LastLoadError` rather than leaking it. This is what makes the fix complete rather than merely pattern-copied.

### 4. Debounce constant (#338)

```csharp
private const int FileChangeDebounceMilliseconds = 100;
...
await Task.Delay(FileChangeDebounceMilliseconds).ConfigureAwait(false); // debounce save flurry
```

Pure refactor — no behavior change.

### 5. DI wiring

`PRism.Core/ServiceCollectionExtensions.cs:53` currently:

```csharp
services.AddSingleton<IConfigStore>(_ => CreateConfigStore(dataDir));
```

becomes:

```csharp
services.AddSingleton<IConfigStore>(sp =>
    CreateConfigStore(dataDir, sp.GetRequiredService<ILogger<ConfigStore>>()));
```

and `CreateConfigStore` takes the logger:

```csharp
private static ConfigStore CreateConfigStore(string dataDir, ILogger<ConfigStore> log)
{
    var store = new ConfigStore(dataDir, log);
    store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
    return store;
}
```

`InitAsync` does **not** raise `Changed` (it reads from disk and starts the watcher only), so no subscriber dispatch occurs during construction — the logger only needs to exist by the time `RaiseChanged` fires at runtime. Logging is registered by the host builder before `IConfigStore` is resolved, so `GetRequiredService<ILogger<ConfigStore>>()` resolves cleanly.

## Deliberate scope boundary

The three existing silent catches are **not** touched:

- `ReadFromDiskAsync` (`catch … when (ex is JsonException or IOException or UnauthorizedAccessException)`)
- `HandleFileChangedAsync`'s IO/JSON filter (now also absorbing OCE, but still only setting `LastLoadError`)
- `TryStartWatcher` (`catch … when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)`)

These already surface via the `LastLoadError` property (a real, UI/health-readable channel). The subscriber fault is the **only** path with no channel today — that is the gap 4c closes, and logging is the right new channel for it specifically. Broadening catch-logging across the IO paths is a separate #338 concern; folding it in would re-couple this surgical change. Stated here so a reviewer reads the bounded scope as intentional, not an omission.

## Blast radius

- **No wire/DTO/UI change.** No serialized shape, endpoint, or frontend surface is touched.
- **No behavior change for any current input.** No production subscriber throws today; the only observable difference is in the (currently unreachable) subscriber-throws case.
- **One semantic shift, unobservable today:** on the *synchronous* API paths, a subscriber that throws a non-OCE exception during `RaiseChanged()` previously bubbled to a 500; under this change it is swallowed + logged and the write returns success. This is correct — the config write did persist; a downstream listener's failure to react is not the writer's failure, and it matches `ReviewEventBus` publisher semantics — but it is a real semantic change, masked only because no subscriber throws. Scoping note: the synchronous-path subscribers are specifically the three AI-state setters (`ServiceCollectionExtensions.cs:58/66/73`). For those, a swallowed throw would mean a `200` to the user while the in-memory `AiModeState`/consent/features gate stays stale — a config-vs-gate divergence, not a benign missed cache-invalidation. Still unreachable (the setters null-coalesce and `Ui.Ai` is backfilled non-null), but the logging is what makes such a fault diagnosable rather than silent.
- **New internal dependency:** `ILogger<ConfigStore>`, threaded through DI. No new package; `Microsoft.Extensions.Logging.Abstractions` is already referenced transitively across `PRism.Core`.

## Acceptance criteria

- [ ] `ConfigStore` takes an optional `ILogger<ConfigStore>` (→ `NullLogger` default); all existing `new ConfigStore(dir)` sites compile unchanged.
- [ ] `RaiseChanged()` isolates each subscriber: a throwing subscriber neither propagates to the caller nor aborts dispatch to siblings; the fault is logged at `Error` with EventId `ConfigStoreSubscriberFaulted`.
- [ ] **Intended behavioral change, explicitly signed off:** on the synchronous write paths (`PatchAsync` / `SetDefaultAccountLoginAsync` / `RecordAiConsentAsync`), a subscriber fault is isolated + logged and the write returns success — the prior 500 propagation is deliberately dropped, mirroring `ReviewEventBus`. This is intended, not a regression; a future reviewer should not revert it as a bug.
- [ ] `OperationCanceledException` from a subscriber propagates out of the synchronous paths (cancellation contract preserved).
- [ ] `OperationCanceledException` from a subscriber on the watcher path is absorbed into `LastLoadError`, not leaked.
- [ ] `Task.Delay(100)` replaced by `Task.Delay(FileChangeDebounceMilliseconds)` (`const int = 100`); debounce behavior unchanged.
- [ ] DI passes a real `ILogger<ConfigStore>`; the three existing IO/JSON silent catches are unchanged in scope (still `LastLoadError`-only).
- [ ] Release build (`TreatWarningsAsErrors`) and full suite green.
- [ ] PR `Closes #323`; `#338` referenced bare (no closing keyword).

## Testing (TDD)

New tests in `tests/PRism.Core.Tests/Config/` exercising the real `ConfigStore.Changed` dispatch contract with **test-only** throwing subscribers (no production subscriber throws — these verify the primitive's contract):

1. **Isolation + siblings + persistence:** register two `Changed` handlers; the first throws `InvalidOperationException`, the second sets a flag. Trigger a write (`PatchAsync` a valid field). Assert: the write does not throw, the second handler ran, and `store.Current` reflects the patch.
   - RED: current `RaiseChanged` propagates → the act throws / sibling never runs.
2. **Fault is surfaced (not silent):** a spy `ILogger<ConfigStore>` captures one `Error` entry with EventId `ConfigStoreSubscriberFaulted` when a subscriber throws.
   - RED: no logger exists / no log emitted.
3. **OCE rethrow (synchronous path):** a subscriber that throws `OperationCanceledException` causes the synchronous write to surface OCE.
   - RED: under naive broad-catch isolation, OCE would be swallowed.
4. **OCE absorbed on the watcher path:** a subscriber that throws `OperationCanceledException` dispatched via the fire-and-forget watcher path (call `HandleFileChangedAsync` directly, or trigger a file-change) is absorbed into `LastLoadError` and does **not** surface as an unobserved task exception. This covers the novel §3 behavior, not just §2's synchronous rethrow.
   - RED: with `RaiseChanged` rethrowing OCE but `HandleFileChangedAsync`'s catch filter unwidened, the OCE leaks (no `LastLoadError`, escapes the task).

The debounce constant is a pure literal→`const` rename covered by existing watcher/debounce tests — no new test.

Test logger: use a minimal capturing `ILogger<ConfigStore>` (or the test project's existing spy-logger helper if present) asserting on level + EventId.

## Out of scope

- Logging the existing `LastLoadError` IO/JSON catches (separate #338 concern).
- Converging logging onto the nested-`Log` source generator (separate #338 item).
- Any change to `FileSystemWatcher` setup, debounce *duration*, or the read/migration pipeline.
