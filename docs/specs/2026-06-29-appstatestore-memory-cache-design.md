# AppStateStore in-memory parsed-state cache — design (#664)

**Status:** draft — awaiting human gate (B2)
**Issue:** [#664](https://github.com/prpande/PRism/issues/664) — `perf(core): AppStateStore re-reads/re-parses/re-migrates state.json on every load`
**Tier / Risk:** T2 / gated B2 (persisted-state surface)
**Author:** Claude Code executor
**Review:** 1× `ce-doc-review` (coherence + feasibility + adversarial) — dispositions in §9.

## 1. Problem

`AppStateStore` holds **no in-memory copy** of the parsed state. Every `LoadAsync`
(and the load inside every `UpdateAsync`) runs the full `LoadCoreAsync` pipeline:
`FileStream` → `ReadToEndAsync` → `JsonNode.Parse` → `MigrateIfNeeded` →
`EnsureCurrentShape` (loops every account × session) → `Deserialize<AppState>`.

Two amplifiers:

1. **Per-tick read amplification.** `InboxRefreshOrchestrator` loads app state every
   inbox tick (`InboxRefreshOrchestrator.cs:258`) purely to project per-PR
   viewed-state — paying a full parse + migrate + deserialize each tick even when
   nothing changed.
2. **Per-stamp read amplification on the write path.** `SubmitPipeline.PersistOrFailAsync`
   → `AppStateStore.UpdateAsync` runs once per draft and once per reply; each
   `UpdateAsync` does a full `LoadCore` (parse + migrate) **and** a full `SaveCore`.
   A review with N drafts + M replies pays (N+M) full **read**-modify-write
   round-trips on the user-blocking submit path.

   **Scope note (what this change removes):** the cache eliminates the **read/parse/migrate**
   half of each `UpdateAsync` — the `LoadCore` re-parse. It does **not** remove the
   **write** half: each `UpdateAsync` still serializes the whole `AppState` + temp-write +
   atomic-move once per stamp (that per-stamp crash-recovery overlay is
   intentional/documented). The win is collapsing (N+M) re-parses to zero, plus the
   per-tick read.

`ConfigStore` already solves the analogous read problem: it keeps `_current` and only
re-reads on a FileSystemWatcher change; the steady-state read is a field access.

## 2. Goal / non-goals

**Goal.** Collapse the steady-state **read** cost of `AppStateStore` to a field access,
mirroring `ConfigStore`. `LoadAsync` serves a cached parsed `AppState`; writes
serialize once and update the cache in place. The per-tick read and the per-stamp
re-parse both stop re-parsing/re-migrating.

**Non-goals.**
- No consumer changes. `InboxRefreshOrchestrator` and `SubmitPipeline` benefit
  transparently; their call patterns are unchanged.
- No FileSystemWatcher. Unlike `config.json`, `state.json` has **no external
  writer** within a process's lifetime (see §4 invariant + its enforcement), so
  there is nothing to watch. See §8 decision 4 for the explicit "no watcher" call.
- No change to the on-disk schema, migration steps, serialization options, or the
  atomic-write mechanism.
- No change to the write-path cost (per-stamp serialize + atomic-move is unchanged).
- No change to public method signatures or `IAppStateStore`.

## 3. Approach

Add a single nullable field and gate every read/write through it.

```csharp
private AppState? _current;   // null = not-yet-loaded / invalidated; non-null = the cached parsed state
```

### 3.1 Read path (`LoadCoreAsync`, called under `_gate` by both `LoadAsync` and `UpdateAsync`)

- **Cache hit** (`_current is not null`): return `_current` directly. No disk I/O,
  no parse, no migrate.
- **Cache miss** (`_current is null`): run the existing full pipeline. On the
  **success** return (current-version, migrate, and read-only/future-version paths
  all reach this return), assign `_current = state` **before returning**.

> **Both write sites are mandatory (feasibility note A).** The migrate path (v_n→v7)
> and the read-only/future-version path return from `LoadCoreAsync` **without** ever
> calling `SaveCoreAsync` (they don't persist). So the cache-set on the
> `LoadCoreAsync` success return (§3.1) is the *only* thing that caches those states —
> it is not redundant with the `SaveCoreAsync` cache-set (§3.2). Dropping it would
> re-run `MigrateIfNeeded` on every load of a migrated/read-only file, defeating the
> perf goal on exactly those paths.

- **Missing-file path:** `LoadCoreAsync` seeds via `SaveCoreAsync(AppState.Default)`
  (which sets `_current` on success — §3.2) and returns `Default`.
- **Corrupt/quarantine path** (`catch (JsonException)`): does **not** unconditionally
  set `_current`. It calls `QuarantineAndResetAsync` (best-effort) and returns
  `AppState.Default`. The cache is populated **only if** the quarantine's
  `SaveCoreAsync(Default)` succeeds (via §3.2). If the resave fails (disk full /
  permissions), `_current` stays `null`, so the next load re-enters the missing-file
  branch and retries the seed write — preserving today's "every load retries the
  seed" self-heal (adversarial F5).

`_current` is read and written only under `_gate` (already held by both callers), so
the cache shares the store's existing single-writer serialization — no new lock.

### 3.2 Write path (`SaveCoreAsync`) — load-bearing ordering

`SaveCoreAsync` is the single funnel for every persisted write (seed default, save,
update, quarantine resave). The cache is updated **only after** the atomic-move
succeeds:

```csharp
// serialize → temp-write → atomic-move (unchanged) …
await AtomicFileMove.MoveAsync(temp, _path, ct).ConfigureAwait(false);
_current = state;   // ← set AFTER the move commits; under _gate
```

> **Load-bearing for #659 (adversarial F3).** Setting `_current` *after* the atomic
> move, under `_gate`, makes disk and cache flip together for any `_gate` holder. This
> ordering — plus the cache-hit read still taking `_gate` (§8 decision 3) — is what
> preserves the #659 "re-read body under submit lock" guarantee (§4). It is a **hard
> invariant, not a tuning choice.** A code comment at this assignment and at the
> cache-hit branch must say so.

Rationale for updating in `SaveCoreAsync` rather than in each caller: it is the one
place every write passes through, so the cache cannot drift from disk on any write
path (seed, `SaveAsync`, `UpdateAsync`, quarantine resave). On a failed write
(exception before/at the move), `_current` is left untouched — the cache keeps the
last-good state, matching disk.

### 3.3 Invalidation (`ResetToDefaultAsync`)

`ResetToDefaultAsync` deletes `state.json` and clears `IsReadOnlyMode`. It does **not**
write a fresh file (the caller restarts the process). Set `_current = null` so that if
any `LoadAsync` runs before the restart, it re-seeds `AppState.Default` from the
missing-file path rather than serving a stale cached instance.

### 3.4 Read-only (future-version) path — and why no watcher is needed

`MigrateIfNeeded` sets `IsReadOnlyMode = true` for a `version > CurrentVersion`
file, returns a best-effort backfilled object, and the pipeline returns that state
**without** persisting it. Caching this best-effort state is correct **because version
detection runs on every cache miss, and a cache miss is the first load of each
process** (§4):

- `IsReadOnlyMode` is sticky for the instance's lifetime (only `ResetToDefaultAsync`
  clears it), so serving the cached state on subsequent loads — skipping the
  re-detect — does not lose the read-only condition detected at first load.
- `SaveAsync`/`UpdateAsync` still throw while `IsReadOnlyMode` is true (the guards are
  unchanged), so the cached best-effort state can never be written back as a
  downgrade.
- **Adversarial F2 (post-boot newer-version downgrade) is closed by the single-instance
  lock, not by a watcher.** A newer PRism binary cannot write a `version > CurrentVersion`
  file *while this instance is live*, because `LockfileManager` (§4) holds
  `state.json.lock` for the whole process lifetime and refuses a second live backend on
  the same dataDir. A *sequential* newer writer (this binary exits → newer binary runs →
  exits → this binary runs again) is caught: the relaunched process's **first** load is a
  cache miss that runs the full pipeline and re-detects the newer version → read-only.
  The only uncovered case is an out-of-band hand-edit of `state.json` to a higher version
  *during* this process's life — out of scope for app-managed state (the issue's premise),
  and explicitly accepted in §8 decision 4.

## 4. Correctness — the cache-coherence invariant (enforced, not merely asserted)

> **Invariant (single-writer).** Within one process, `AppStateStore` is the **sole
> writer** of its `state.json`, and every read that must observe a write goes through
> the same instance under `_gate`. No other live process and no out-of-band code path
> writes that `state.json`.

This is the premise the issue states and the reason the cache needs no watcher. It is
**enforced**, not assumed:

- **Cross-process: `LockfileManager` / `state.json.lock`.** Production acquires a
  per-dataDir lockfile at startup (`Program.cs:232`, held until `ApplicationStopping`)
  using `FileMode.CreateNew` + `FileShare.None` and a liveness probe. A second live
  PRism on the same dataDir fails `Acquire` with `LockfileException(AnotherInstanceRunning)`
  ("two backends writing state.json is the exact thing it exists to prevent" —
  `LockfileManager.cs`). So concurrent multi-writer — the scenario behind adversarial
  F1/F2 — cannot occur. (The desktop sidecar launches `PRism.Web` through the same
  `Program.cs`, so it is covered too.)
- **In-process: singleton.** `AppStateStore` is registered as a singleton
  (`ServiceCollectionExtensions.cs:80`) — exactly one instance, one cache, per process.
- **Ordering: `_gate`.** All writes funnel through `SaveCoreAsync` (under `_gate`); all
  reads through `LoadCoreAsync` (under `_gate`). `_gate` provides the happens-before
  edge between a write's `_current = state` and a later read's `return _current`.
- **#659 preserved.** The submit lock is a separate primitive, but the re-read
  (`SubmitPipeline.ReloadDraftBodyAsync`/`ReloadReplyBodyAsync`/`ReloadPrRootBodyAsync`
  → `LoadAsync`) and the concurrent `PUT /draft` edit (→ `UpdateAsync`) both go through
  this store under `_gate`. A concurrent edit updates `_current` after its atomic move;
  the cache-hit re-read observes it. The cache is exactly as fresh as a disk re-read
  would have been. (Verified by feasibility review tracing both call paths.)

`AppState` is a `sealed record` over `ImmutableDictionary` — fully immutable. Sharing
the cached `_current` reference across callers is safe; a caller cannot mutate it, and
every transform produces a new instance (mirrors `ConfigStore.Current`).

**Test-isolation corollary (adversarial F4).** Tests that construct **two**
`AppStateStore` instances on one directory (`AppStateStoreTests` store1/store2;
migration `writeStore`/`readStore`; the `PrDetailEndpointsTests` seed-before-`CreateClient`
pattern) stay correct **only because each instance's first `LoadAsync` is a cache miss
that reads disk, and no startup/hosted-service path calls `LoadAsync` before a test's
out-of-band seed.** The DI singleton is a lazy factory (resolved on first request, after
the seed); `InboxRefreshOrchestrator` loads app state on its **tick** (line 258), not at
host boot. This ordering invariant is now load-bearing — the pre-merge re-check (§7)
greps for `LoadAsync` in `IHostedService`/startup paths, not just `state.json` writers.

## 5. What does NOT change

- `MigrateIfNeeded`, `EnsureCurrentShape`, `MigrationSteps`, `CurrentVersion`.
- `SaveCoreAsync`'s temp-write + atomic-move; `QuarantineAndResetAsync`'s best-effort behavior.
- `IsReadOnlyMode` get/set semantics and the read-only guard in `SaveAsync`/`UpdateAsync`.
- `IAppStateStore` and every public signature.
- On-disk JSON shape and serializer options. Per-stamp write cost.

## 6. Test plan (TDD — non-bug / refactor: new tests authored test-first)

New tests in `tests/PRism.Core.Tests/State/AppStateStoreCacheTests.cs` (new file, for
cohesion — §8 decision 2):

1. **Steady-state load does not re-read disk after first load** (the acceptance test
   the issue names). Construct a store, `LoadAsync` once (populates the cache from
   disk). Then mutate `state.json` **out-of-band** on disk to a distinguishable valid
   value. Assert a second `LoadAsync` returns the **cached (pre-mutation)** value, not
   the on-disk one. This is a white-box assertion that the steady-state path serves the
   cache (it deliberately performs the out-of-band write §4 says production never does);
   current code fails it (re-reads, returns mutated), cached code passes. *(This is the
   coherent restatement of the issue's "two sequential `UpdateAsync` calls don't re-read
   the file" — see also test 2 for the `UpdateAsync`/`UpdateAsync` framing.)*
2. **Two sequential `UpdateAsync` calls re-parse once, not per-call.** After the first
   `UpdateAsync` populates the cache, out-of-band-mutate `state.json`, then a second
   `UpdateAsync` whose transform asserts it received the **cached** prior state (not the
   out-of-band disk value) — proving the second `UpdateAsync` did not re-read/re-parse.
3. **Cache coherence after write.** `UpdateAsync` sets a value; a following `LoadAsync`
   returns the new value (same instance) without touching disk.
4. **`SaveAsync` updates the cache.** `SaveAsync(s)` then `LoadAsync` returns `s`.
5. **`ResetToDefaultAsync` invalidates.** After reset, an in-process `LoadAsync` returns
   `AppState.Default` (re-seeded), not the pre-reset cached state.
6. **Read-only path caches.** A future-version `state.json`: first load sets
   `IsReadOnlyMode`; a second load returns cached state and `IsReadOnlyMode` stays true;
   `SaveAsync` still throws.
7. **Corrupt path caches default via successful resave.** A corrupt `state.json`: first
   load quarantines + returns `Default`; cache holds `Default`; `SaveAsync` succeeds
   (read-only was cleared). *(F5's resave-failure branch is hard to force deterministically
   on disk; covered by reasoning in §3.1 + §7, not a unit test — see §8 decision 5.)*
8. **Cross-instance round-trip still works.** Instance A writes; a new instance B reads
   the persisted value (regression guard that the cache did not break the
   `writeStore`/`readStore` pattern).

Plus: the full existing AppStateStore / Submit / Inbox suites stay green.

## 7. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Concurrent second writer on one dataDir freezes a stale cache → data loss | `LockfileManager` (§4) prevents a second live backend per dataDir; enforced at `Program.cs:232`. Not an assumption. |
| Post-boot newer-version file → silent downgrade (F2) | Single-instance lock blocks a concurrent newer writer; sequential relaunch re-detects on the first-load cache miss (§3.4). |
| A **single-instance** test writes `state.json` out-of-band then expects `LoadAsync` to see it | Audited: the two-instance pattern reads disk on B's first load; `EditInjectingStore` writes **through** the store (`UpdateAsync`). Pre-merge re-check greps test `state.json` write-paths **and** `LoadAsync` in startup/`IHostedService` paths (F4). |
| A future hosted service loads app state at host boot, before a test seed | New ordering invariant documented in §4; pre-merge grep for `LoadAsync` in startup paths. |
| Quarantine resave failure leaves `_current=Default` while file absent → loses seed-retry self-heal (F5) | Corrupt path sets cache only via the quarantine `SaveCoreAsync` success (§3.1); on resave failure `_current` stays `null` → next load retries the seed. |
| A future lock-free cache-hit fast path reopens #659 | §8 decision 3 reclassifies the `_gate`-on-hit ordering as a **hard invariant**; lock-free fast path struck from scope; load-bearing comments in code. |
| Shared mutable reference leaks | `AppState` is immutable (`sealed record`/`ImmutableDictionary`); mirrors `ConfigStore.Current`. |

## 8. Decisions (resolved) — confirm at the gate

1. **Read-test mechanism:** out-of-band disk mutation after first load, asserting the
   cached value is returned (tests 1–2). No new seam needed. **Resolved: option (a).**
2. **Test location:** new `AppStateStoreCacheTests.cs`. **Resolved.**
3. **Cache-hit `LoadAsync` keeps `_gate`:** **Yes — hard invariant** (not "recommended/open").
   The `_gate`-protected ordering is load-bearing for #659 (F3). The lock-free fast path
   (`ConfigStore.Current`-style) is **struck from scope** — it would silently reopen the
   #659 race with no failing test.
4. **No FileSystemWatcher for `state.json`:** **Accepted.** `state.json` is app-managed
   with an enforced single live writer (§4); a watcher (+ debounce + mtime-poll fallback,
   the machinery `ConfigStore` carries for *user-editable* `config.json`) buys nothing
   here. The single uncovered case — an out-of-band hand-edit to a higher version during
   a live process — is explicitly out of scope. **This is the one judgment call the B2
   gate should bless**, since adversarial F1/F2 proposed adding a watcher/mtime-revalidation.
5. **F5 resave-failure branch is covered by reasoning, not a unit test** (forcing a disk
   resave failure deterministically is brittle); the implementation (cache-set only on
   resave success) is the guarantee.

## 9. ce-doc-review dispositions (1× pass: coherence + feasibility + adversarial)

| # | Finding | Sev | Disposition | Note |
|---|---------|-----|-------------|------|
| C1 | "(verified §7)" cross-ref wrong | Med | **Applied** | Now references the §6 cross-instance test + §4 audit. |
| C2 | Test #1 title/assertion/mechanism mismatch | High | **Applied** | Split into coherent tests 1 (load) + 2 (`UpdateAsync`/`UpdateAsync`). |
| Fea-A | Cache must be set on `LoadCoreAsync` success return, not only `SaveCoreAsync` | Low | **Applied** | §3.1 callout: migrate/read-only paths don't persist, so the load-return cache-set is mandatory. |
| Fea-B | Per-stamp *write* cost only half-removed | Low | **Applied** | §1/§2 scope notes clarify the write half is unchanged by design. |
| F1 | Single-writer premise asserted, not enforced; 2nd writer → divergence | High | **Partially applied** | Premise is **enforced** by `LockfileManager` (reviewer missed it; claimed "no cross-process lock"). Cited in §4. Rejected: data-loss severity (lock prevents it) and the watcher/mtime mitigation (decision 4). |
| F2 | Cache defeats read-only downgrade post-boot | High | **Partially applied** | Documented §3.4: detection runs on first-load cache miss; lock blocks a concurrent newer writer; sequential relaunch re-detects. Rejected: the downgrade-hole severity and watcher mitigation. |
| F3 | "#659-safe" holds only conditionally; lock-free fast path would break it | Med | **Applied** | §3.2 + §8.3: `_gate`-on-hit and post-move `_current` set are hard invariants; lock-free fast path struck; code comments required. |
| F4 | Test-audit rests on unstated load-before-seed ordering | Med | **Applied** | §4 corollary + §7: ordering invariant documented; pre-merge greps `LoadAsync` in startup/`IHostedService` paths; verified orchestrator loads on tick not boot. |
| F5 | Quarantine resave failure loses seed-retry self-heal | Low | **Applied** | §3.1: corrupt path caches only via successful resave; `_current=null` on failure. |
