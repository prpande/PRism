# #323 Core robustness — Slice B (hands-off) design

**Issue:** [#323](https://github.com/prpande/PRism/issues/323) (epic [#317](https://github.com/prpande/PRism/issues/317), Theme C)
**Date:** 2026-06-20
**Tier:** T2 — Light. **Risk:** hands-off (no risk surface touched; item 3 / submit-pipeline is explicitly *out* of this slice).

## Scope

#323 groups four robustness findings. The user split it: this slice ships the
**hands-off** items only; **item 3** (typed not-found exception across the submit
pipeline + `PrState` enum/ordinal) is a separate B2-gated follow-up PR.

In scope here:

| # | Finding | File |
|---|---------|------|
| 1 | `ReviewEventBus.Publish` has no per-handler fault isolation | `PRism.Core/Events/ReviewEventBus.cs` |
| 2 | Reconcile per-draft catch-all swallows the exception with zero logging | `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs` |
| 4a | Lockfile `File.Delete` can leak a raw `IOException` out of `Acquire` | `PRism.Core/Hosting/LockfileManager.cs` |
| 4b | Orchestrator `Task.WhenAny(_, Task.Delay(timeout, ct))` leaks the delay timer; `_firstSnapshotTcs` not `readonly` | `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` |

**Deferred out of this slice (documented, not silently dropped):**

- **Item 3** — typed not-found exception + `PrState` ordinal/enum. B2 (submit
  pipeline). Separate gated PR per the agreed plan.
- **Item 4c** — `ConfigStore.HandleFileChangedAsync` raises `Changed` (arbitrary
  subscribers) inside a catch filtered to IO/JSON types, so a non-IO subscriber
  exception escapes as an **unobserved task exception**; plus the magic
  `Task.Delay(100)` debounce. **Deferred because** the correct fix must *surface*
  the subscriber fault (not silently swallow it — that is the very anti-pattern
  item 2 calls out), and `ConfigStore` has **no `ILogger`** today. Adding one is a
  new dependency + DI wiring, and the alternative (changing `RaiseChanged`'s
  exception semantics for its three synchronous API-thread callers) has real
  behavioral blast radius. Neither is "fix in passing." **Item 1 makes 4c's risk
  currently unreachable — but does not structurally close it.** Verified (adversarial
  Finding 1): the present `IConfigStore.Changed` subscriber set is five handlers
  (`ServiceCollectionExtensions.cs:58/66/73` — non-throwing field sets;
  `PrDetailLoader.cs:82` — concurrent-dict ops, non-throwing; `InboxRefreshOrchestrator.cs:63`
  — throws only via `_events.Publish`, which this slice isolates). So after item 1
  **no** current subscriber can escape a non-OCE exception into `RaiseChanged`'s
  synchronous `Changed?.Invoke`. But `RaiseChanged` (`ConfigStore.cs:104`) is still
  a bare invoke inside a catch filtered to IO/JSON types (`:594`): the day someone
  adds a `Changed` subscriber that throws outside that filter and not through the
  isolated bus, the unobserved-task-exception returns with no compile/test signal.
  4c should land as its own PR (or under **#338**) — **not** folded into the item-3
  PR, which touches the submit pipeline and shares no files with `ConfigStore`;
  bundling would re-couple what this slice deliberately decoupled. The 4c PR carries
  a guard note: *any new `IConfigStore.Changed` subscriber that can throw outside the
  IO/JSON filter re-opens 4c* (plus a one-line code comment at `ConfigStore.cs:592`
  recording the catch-filter constraint — deferred to that PR to keep this slice
  from touching `ConfigStore`).

Because both 3 and 4c are deferred, **this PR does not close #323** — it checks off
items 1, 2, 4a, 4b on the epic and leaves the issue open for the follow-ups.

## Item 1 — Event-bus per-handler fault isolation

**Current** (`ReviewEventBus.cs:16`):

```csharp
foreach (var d in snapshot) ((Action<TEvent>)d)(evt);
```

One throwing subscriber aborts dispatch to the rest **and** propagates into the
publisher. Knock-on (`ActivePrPoller.TickAsync`): `_bus.Publish(new ActivePrUpdated(...))`
(`:154`) runs inside the per-PR `try`; the `state.LastHeadSha = …` updates
(`:166-171`) sit *after* it. A subscriber throw → caught by the poller's
`catch (Exception)` (`:187`) → `ApplyBackoff` on a healthy PR **and** the
`LastHeadSha` update is skipped, so the same event re-fires every subsequent tick.

**Fix:** isolate each handler.

```csharp
foreach (var d in snapshot)
{
    try { ((Action<TEvent>)d)(evt); }
    catch (OperationCanceledException) { throw; }   // cooperative cancellation propagates
    catch (Exception ex)                            // CA1031: one bad subscriber must not abort the rest
    {
        s_subscriberFaulted(_log, typeof(TEvent).Name, ex);
    }
}
```

- **Logging seam:** add an **optional** `ILogger? log = null` constructor param
  defaulting to `NullLogger.Instance`. This mirrors `InboxRefreshOrchestrator`'s
  existing pattern and keeps all ~45 `new ReviewEventBus()` call sites + the
  `AddSingleton<IReviewEventBus, ReviewEventBus>()` registration valid (DI resolves
  the real `ILogger<ReviewEventBus>` from the container; tests get `NullLogger`).
  Use a `LoggerMessage.Define` delegate (`s_subscriberFaulted`) for the
  source-generated-logging convention already used in this codebase.
- **OCE semantics:** rethrowing `OperationCanceledException` preserves cooperative
  cancellation — a handler observing a canceled token still aborts the publish, as
  today. Only non-OCE faults are isolated.
- **Ordering note:** the loop already runs over a `snapshot` array taken under the
  lock, so isolation does not change re-entrancy/unsubscribe behavior.
- **Named behavioral delta at `ActivePrPoller` (adversarial Finding 3):** today a
  throwing eviction handler propagates out of `_bus.Publish` (`:154`) → the poller's
  broad catch (`:187`) → **both** `state.LastHeadSha = …` (`:166`) **and**
  `_cache.Update` (`:176`) are skipped (and backoff applies). After this fix the
  throw is logged-and-swallowed, so `Publish` returns and `_cache.Update` runs +
  head advances. This **changes the faulting-handler coupling** the load-bearing
  comment at `ActivePrPoller.cs:150` documents — from "fault ⇒ skip cache update"
  to "fault ⇒ proceed with cache update." That is the **correct** direction (the
  current behavior re-fires the event forever), and it is reachable-as-torn-state
  only by a handler that *partially* fails mid-eviction — which no current handler
  can: `PrDetailLoader.OnActivePrUpdated` does only concurrent-dict reads +
  `TryRemove`, neither of which throws. Test 3 asserts this delta deliberately
  (head advanced → no re-fire), not incidentally.

### Tests (item 1)

1. `ReviewEventBusTests`: a throwing subscriber does **not** prevent a second
   subscriber from receiving the event, and `Publish` does **not** throw.
   (Direct unit test of the bus — red on main: today the throw propagates and the
   second subscriber never runs.)
2. `ReviewEventBusTests`: a subscriber throwing `OperationCanceledException` **does**
   propagate out of `Publish` (cancellation is not swallowed).
3. `ActivePrPoller` regression. **Construct the poller directly with a real
   `new ReviewEventBus()` — do NOT reuse `ActivePrPollerBackoffTests.Build()`,
   which wires `FakeReviewEventBus` whose `Subscribe` is a `NullDisposable` no-op;
   a throwing handler added to it is never invoked, so the test would pass
   vacuously on main and give no red-on-main signal** (scope Finding 7). Subscribe a
   throwing handler to `ActivePrUpdated`, then run two ticks against a fake review
   service returning the **same** snapshot both times. Assert:
   - (a) no backoff after tick 1 (`NextRetryAt == null`, `ConsecutiveErrors == 0`);
   - (b) tick 2 emits **no second** `ActivePrUpdated` — proving tick 1 advanced
     `LastHeadSha` (and ran `_cache.Update`), so the event does not re-fire.

   `LastHeadSha` lives on `ActivePrPollerState` with no public accessor, so the
   two-tick "no re-fire" check is the observable proxy for "head advanced" (scope
   Finding 2). Red on main: tick 1 applies backoff and skips the head advance, so
   tick 2 re-emits `ActivePrUpdated` (and/or `ConsecutiveErrors > 0`).

## Item 2 — Reconcile catch-all logging

**Current** (`DraftReconciliationPipeline.cs:197-212`): the per-draft
`catch (Exception)` adds a `Stale (NoMatch)` result and **discards** the exception.
A GitHub 500 / rate-limit during reconcile is indistinguishable from a genuine
no-match. Every comparable broad catch in the codebase logs.

**Fix:** thread an **optional** `ILogger? logger = null` (→ `NullLogger.Instance`)
as a **constructor** param. `DraftReconciliationPipeline` is `new()`-ed directly
(not DI) at `PrReloadEndpoints.cs:93` + ~30 test sites, so an optional ctor param
keeps every site compiling. Log draft id + exception at **Warning** inside the
catch:

```csharp
catch (Exception ex)
{
    s_draftReconcileFaulted(_logger, draft.Id, ex);   // Warning
    reconciledDrafts.Add(MakeStale(draft, StaleReason.NoMatch, forcePush: false,
        resolvedFilePath: draft.FilePath, resolvedLineNumber: draft.LineNumber));
}
```

Wire the real logger at the one production call site: add `ILoggerFactory lf` to
`HandleReloadAsync`'s minimal-API parameter list (consistent with
`PrCommentEndpoints`, which already injects it) and pass
`lf.CreateLogger<DraftReconciliationPipeline>()` into the constructor.

The CA1822 "mark static" suppression on `ReconcileAsync` is removed — the class is
no longer stateless (it now holds the logger field), which also aligns with the
suppression's own note that the instance shape exists to become a DI seam.

### Tests (item 2)

- A `FakeFileContentSource` that **throws** for one draft → that draft comes back
  `Stale (NoMatch)` (unchanged behavior) **and** a capturing `ILogger` recorded one
  Warning carrying the draft id. Red on main: no logger param exists / nothing
  logged. (`PRism.Core.Tests` has no reusable generic capturing-logger — the one in
  `ActivePrPollerSnapshotLogTests` is hardcoded to `ILogger<ActivePrPoller>` with an
  `EventId == 3` filter (feasibility Finding 6). Write a small
  `CapturingLogger<DraftReconciliationPipeline>` test double for this test.)

## Item 4a — Lockfile delete guard

**Current** (`LockfileManager.cs:55, 67`): two bare `File.Delete(path)` calls. If
the delete throws `IOException`/`UnauthorizedAccessException` (e.g. another process
holds the stale lockfile open), it escapes `Acquire` **raw**, where every other
failure is wrapped in `LockfileException`.

**Fix:** treat a failed take-over delete as "another instance is running" — wrap
each in try/catch and translate to
`LockfileException(LockfileFailure.AnotherInstanceRunning, …)`. This is the correct
semantic: if we cannot remove the existing lock, we must not assume we own it.

```csharp
try { File.Delete(path); }
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
{
    throw new LockfileException(LockfileFailure.AnotherInstanceRunning,
        "PRism is already running.", ex);
}
```

**Add the missing ctor** (verified: `LockfileException.cs` has `(string, Exception)`
and `(LockfileFailure, string)` but **no** `(LockfileFailure, string, Exception)` —
feasibility + scope + adversarial all confirm). One line, no blast radius:

```csharp
public LockfileException(LockfileFailure reason, string message, Exception inner)
    : base(message, inner) { Reason = reason; }
```

### Tests (item 4a)

- The existing lockfile tests inject a fake probe via the internal `Acquire`
  overload. Add a test where deletion is forced to fail — simplest reliable route:
  hold the lockfile open with a `FileShare.None` `FileStream` in the test so
  `File.Delete` throws `IOException`, drive the stale-takeover branch, and assert a
  `LockfileException(AnotherInstanceRunning)` (not a raw `IOException`) surfaces.
  Red on main: raw `IOException` escapes. *(If holding the file open proves flaky
  on the CI file system, fall back to asserting the wrap via a seam; decide during
  TDD.)*

## Item 4b — Orchestrator timer leak + readonly

**Current** (`InboxRefreshOrchestrator.cs:68-74`):

```csharp
var task = _firstSnapshotTcs.Task;
var completed = await Task.WhenAny(task, Task.Delay(timeout, ct)).ConfigureAwait(false);
return completed == task;
```

`Task.Delay(timeout, ct)` roots a timer for the full `timeout` (10 s at the call
site) even when the snapshot wins immediately — a per-cold-start-wait timer leak.

**Fix:**

```csharp
public async Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
{
    if (Volatile.Read(ref _current) != null) return true;
    try
    {
        await _firstSnapshotTcs.Task.WaitAsync(timeout, ct).ConfigureAwait(false);
        return true;
    }
    catch (TimeoutException) { return false; }
}
```

`Task.WaitAsync` disposes its internal timer the moment the awaited task completes —
no leak. Also mark `_firstSnapshotTcs` **`readonly`** (verified: init at `:28`,
read at `:71`, `TrySetResult` at `:274`; never reassigned).

**Behavior delta (small, called out):** on `ct` **cancellation** the method now
throws `OperationCanceledException` (`Task.WaitAsync` throws `TaskCanceledException`,
an OCE subtype) instead of returning `false`. **Verified safe at the call site:**
the sole production caller is `InboxEndpoints.cs:46` (`MapGet("/api/inbox", …)`)
passing the request-abort token, and it has **no `try/catch` wrapping the call with
a `false`-return handler** that OCE would bypass — the OCE propagates to the ASP.NET
host, which translates an aborted-request OCE into a client-disconnect (no 503 body
rendered to a client that is already gone). The **timeout** path is unchanged
(`TimeoutException` → `false`). Existing tests use `CancellationToken.None`, so they
exercise only the timeout/success paths and stay green.

### Tests (item 4b)

- Timeout path still returns `false` (existing test at
  `InboxRefreshOrchestratorTests.cs:397` covers this — keep green).
- Success path still returns `true` (existing test at `:261` — keep green).
- New: `ct` already canceled → `WaitForFirstSnapshotAsync` throws
  `OperationCanceledException` (documents the intentional delta).

## Acceptance criteria (this slice)

- [ ] A throwing bus subscriber no longer prevents other subscribers from receiving
  the event, no longer propagates into the publisher, and (poller-level) no longer
  triggers backoff or blocks the `LastHeadSha` advance. (tests 1, 3 — red on main)
- [ ] An OCE-throwing subscriber still propagates (test 2).
- [ ] Reconcile failures are logged at Warning with the draft id; a transport
  failure is now distinguishable from a genuine no-match (item-2 test).
- [ ] A failed lockfile take-over delete surfaces as
  `LockfileException(AnotherInstanceRunning)`, not a raw `IOException` (item-4a test).
- [ ] `WaitForFirstSnapshotAsync` no longer roots a `Task.Delay` timer on the
  snapshot-wins path; `_firstSnapshotTcs` is `readonly` (item-4b tests).

## Out of scope / non-goals

- Item 3 (submit pipeline / `PrState`) — separate B2 PR.
- Item 4c (ConfigStore) — deferred, see Scope.
- No wire-shape change, no DTO change, no UI change → no frontend-consumer check
  needed.

## Risk classification (record in triage)

- **Tier:** T2 — four small files, one real design choice (optional-logger seam vs
  threading the call site), single coherent robustness unit.
- **Risk:** **hands-off.** None of: auth/PAT, submit pipeline, persisted schema,
  cross-tab stamp, desktop sidecar, security surface, or a behavioral architectural
  invariant is touched. The event-bus change is additive fault isolation; logging
  is additive; the lockfile change strengthens an existing failure mode; the
  orchestrator change is a timer-lifetime fix. Pre-PR re-check will re-verify the
  committed diff against the Axis-B table.

## `ce-doc-review` dispositions (1× — coherence, feasibility, adversarial, scope)

| Finding | Disposition | Note |
|---|---|---|
| Scope 2 + 7 — test 3 `LastHeadSha` unreadable; reusing `Build()` (FakeReviewEventBus/NullDisposable) → vacuous pass | **Applied** | Test 3 rewritten: construct poller with real bus; two-tick "no re-fire" proxy |
| Adversarial 3 — item 1 flips poller faulting-handler path (skip → proceed `_cache.Update`) | **Applied** | Named in item 1; test 3 asserts it deliberately |
| Scope 1 / Adversarial 2 — ground OCE-benign claim in the real call site | **Applied** | Verified `InboxEndpoints.cs:46` has no `false`-branch try/catch |
| Scope 3 / Feasibility 1 — `LockfileException(reason,msg,inner)` ctor missing | **Applied** | Spec de-hedged; ctor add specified |
| Adversarial 1 — "de-risks 4c" overstated | **Applied** | Reworded to "currently unreachable, not structurally closed" + guard note |
| Adversarial 4 — "folds into item-3 PR or #338" re-couples files | **Applied** | Resolved to standalone/#338, not item-3 PR |
| Feasibility 6 — no reusable capturing-logger in `PRism.Core.Tests` | **Applied** | Spec notes writing a small `CapturingLogger<DraftReconciliationPipeline>` |
| Coherence 1 — call-site counts ~40/~25 | **Applied** | Tightened to ~45/~30 |
| Feasibility 2/3, Scope 4/5/6, Adversarial 2, Coherence (no contradictions) | **Skipped** | Positive confirmations — no change needed |
| Adversarial 1 (optional) — code comment at `ConfigStore.cs:592` | **Deferred** | To the 4c PR; keeps this slice from touching `ConfigStore` |
