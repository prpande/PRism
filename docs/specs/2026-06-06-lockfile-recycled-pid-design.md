# LockfileManager recycled-PID stale lock — design

**Issue:** [#107](https://github.com/prpande/PRism/issues/107) · **Tier:** T2 · **Risk:** hands-off
· **Area:** `PRism.Core/Hosting` (single-instance guard)

## Problem

`LockfileManager.Acquire` can refuse to start PRism with a false **"PRism is
already running (PID NNNNN)"** error when a stale lockfile's PID has been recycled
by the OS to an unrelated process. After any unclean exit (crash, `kill`, a close
path that skips `LockfileHandle.Dispose`), the lockfile survives. If the OS then
recycles that PID to a long-lived process (on a dev box, commonly a persistent
`dotnet` MSBuild build-server node), relaunching PRism crashes at startup. Manual
recovery is deleting `%LOCALAPPDATA%\PRism\state.json.lock` — a file the user does
not know exists. Under the Electron shell this presents as **"PRism failed to
start — Backend exited before reporting a port."** The desktop start/stop cadence
makes recycled-PID collisions likely.

## Root cause (confirmed)

`PRism.Core/Hosting/LockfileManager.cs`, `IsAlive`:

```csharp
private static bool IsAlive(int pid, string lockedBinaryPath, string currentBinaryPath)
{
    try
    {
        using var p = Process.GetProcessById(pid);
        return string.Equals(lockedBinaryPath, currentBinaryPath, StringComparison.OrdinalIgnoreCase);
    }
    catch (ArgumentException) { return false; }
    catch (InvalidOperationException) { return false; }
}
```

It compares `lockedBinaryPath` (the path recorded **in the lockfile**) against
`currentBinaryPath` (the path of the instance **relaunching now**). When you
relaunch the *same* binary, those two strings are always equal, so **any** live
process owning the recycled PID makes `IsAlive` return `true`. The function never
inspects what the process at `pid` actually **is** — the in-line comment claims
"If the binary differs, the PID was recycled — treat as stale," but it compares
the wrong two values to detect that.

The existing test `Acquire_recovers_from_PID_alive_but_different_binary` only
passes today because it sets `lockedBinaryPath != currentBinaryPath`; it does not
exercise the **relaunch** case (`locked == current`) that is the actual bug.

## Decision (Approach A — real executable path)

Resolve the **actual** executable path of the running process at `pid` and compare
it to the **locked** binary path. Declare "another live PRism" only when the live
process's real executable path matches the locked path. Otherwise — dead PID,
real path differs, or the path is unreadable — the lock is stale or
unattributable, handled per the rule below.

### Why path-only, not path + StartTime

An earlier draft added a recorded `Process.StartTime` to also distinguish a
*same-path* PID recycle (a dead PRism's PID reused by a new process running the
**identical** PRism exe path). Rejected after review (`Approach B`, below): the
StartTime variant fixes a strictly larger bug class but introduces a
`DateTimeKind`-normalization trap and an **upgrade-while-running double-run
regression vs. `main`** (an old-format lock records lock-creation-time, not real
start time, so post-fix code mis-reads a live old instance as stale and takes
over), for **negligible real-world benefit**: the only case path-only misses is a
PID recycled onto *another process at the exact PRism binary path* — which is
essentially another PRism instance, for which *refusing* is the correct outcome
anyway. Path-only fixes the reported bug (recycle onto `dotnet.exe`, a **different**
path) with a smaller failure surface and no lockfile-format change.

### `IsAlive` reads the live process, not metadata

Resolve the running process's real `MainModule?.FileName` via an injectable probe
(below) and compare it to the **locked** `BinaryPath`. The `currentBinaryPath`
parameter is removed from the liveness decision — it was the source of the bug.
(`Acquire` still records `currentBinaryPath` into the *new* lockfile via
`TryAtomicCreate`; that, and the `started-at` field's existing creation-time
semantics, are unchanged. No lockfile-format change → no migration.)

### Testability seam (the T2 design choice)

`IsAlive` over a *real* `Process.GetProcessById` can only be unit-tested with real
PIDs, which cannot deterministically reproduce an access-denied / unreadable
process. Introduce a narrow injectable probe:

```csharp
public sealed record RunningProcessInfo(string? ExecutablePath);

// Returns null  -> no live process with that PID (dead / never-existed).
// Returns a record -> process is alive; ExecutablePath is null if the real path is
//                     unreadable (access denied / cross-bitness / unsupported OS).
public static LockfileHandle Acquire(
    string dataDir, string currentBinaryPath, int currentPid,
    Func<int, RunningProcessInfo?>? probeProcess = null)
```

`probeProcess` defaults to a real implementation built on `Process`. Tests inject
a fake. The default is an **optional parameter**, so the `Program.cs` call site is
unchanged and the production path uses the real probe. No mutable static (keeps
the test suite parallel-safe). The probe is reached **only on the lock-contended
branch** (an existing, readable lockfile is present); the common no-lock launch
hits the atomic-create fast path and never pays the `MainModule` cost.

The real default probe mirrors the existing `ParentLivenessProbe.StartTimeOfProcess`
catch set exactly (it solves the same recycle-resistant-liveness problem):

- `Process.GetProcessById(pid)` throws `ArgumentException` when no such process
  exists → return `null` (dead PID).
- The process **exited** between lookup and probe (`process.HasExited`, or a
  `InvalidOperationException` raised while reading `MainModule`) → return `null`
  (dead PID — take over). Classifying an exited process as "unreadable → refuse"
  would narrowly reintroduce #107 if a recycled PID's process dies mid-probe.
- Reading `MainModule?.FileName` throws `Win32Exception` (access denied,
  other-user/elevated, cross-bitness) or `NotSupportedException` (unavailable on
  this platform/process) → return `RunningProcessInfo(null)` (alive but
  unreadable → conservative refuse).

> `Win32Exception` lives in `System.ComponentModel`, which `LockfileManager.cs`
> does **not** currently import — add `using System.ComponentModel;` (as
> `ParentLivenessProbe.cs` does).

### Liveness rule (in `IsAlive`)

Given `probe(pid)`:
- `null` → **stale** (no live process; take over).
- alive, `ExecutablePath` **readable and differs** from locked `BinaryPath`
  (ordinal-ignore-case) → **stale** (recycled PID running a different exe — the
  reported case; take over).
- alive, `ExecutablePath` **readable and matches** locked `BinaryPath` →
  **another live PRism** (throw `AnotherInstanceRunning`).
- alive, `ExecutablePath` **unreadable** (`null`) → **another live PRism**
  (refuse). See policy below.

**Ambiguous-case policy (access-denied / unreadable identity): refuse (treat as
alive).** This is **conservative — it matches `main`'s current behavior** (which
also refuses a same-path live PID) and therefore opens **no new double-run
window**: the fix improves only the *readable* case (the reported bug), and is
never *less* safe than today for the unreadable case. The alternative (take over
when we cannot positively attribute the live process) would let a second PRism
launch against a process we cannot even inspect — e.g. a genuine PRism running at
a different integrity level — and two backends writing `state.json` concurrently
is exactly what the single-instance guard exists to prevent. The reported bug
(`dotnet.exe`/MSBuild) is a same-user, **readable** process, so refusing on
unreadable does not regress the filed case. (This deliberately departs from the
issue's suggested "treat as stale and take over" lean, after review showed that
lean opens a double-run window the readable-path fix doesn't need.)

## Rejected alternatives

- **Approach B — path + recorded `Process.StartTime`.** Also distinguishes a
  same-path PID recycle. Rejected: (1) `Process.StartTime` is `Kind=Local`;
  comparing it to a persisted value without `.ToUniversalTime()` on both sides
  mis-reads a genuine instance as stale by the full UTC offset — a trap the seam
  unit tests (UTC fakes) would not catch. (2) Changing `started-at` from
  lock-creation-time to real start time makes an old-format live lock (written by
  a pre-fix build) read as stale → **take over → double-run during an
  upgrade-while-running window**, a regression vs. `main`, fixable only with a
  lockfile version-marker. (3) The only bug class it adds over path-only is a
  recycle onto *another PRism at the same path*, where refusing is correct anyway.
  Net: larger failure surface, lockfile-format change, for negligible benefit.
- **Mutable static probe hook** (`internal static Func<…> Probe`). Simpler call
  site but races across xUnit's parallel test collections and leaks state between
  tests. Rejected for the optional-parameter injection above.
- **Compare `currentBinaryPath` to the live process path** (keep the parameter,
  just fix what it's compared against). The liveness question is purely "is the
  process that wrote this lock still running as PRism," answered against the
  *locked* record; threading `currentBinaryPath` into liveness re-invites the same
  conceptual error.

## Acceptance criteria

- [ ] A live PID whose **real executable path differs** from the locked
  `BinaryPath` (the reported recycled-PID/`dotnet.exe` case), with
  `locked == current` binary path → `Acquire` **takes over** (no throw, new lock
  written). *This is the failing case on `main`.*
- [ ] A live PID whose **real executable path matches** the locked `BinaryPath`
  → `Acquire` throws `LockfileException(AnotherInstanceRunning)` (a genuine
  running instance is still refused).
- [ ] A live PID whose identity is **unreadable** (probe returns
  `RunningProcessInfo(null)`) → `Acquire` throws `AnotherInstanceRunning`
  (documented conservative ambiguous-case policy; no new double-run window).
- [ ] A dead/never-existed PID → `Acquire` **takes over** (regression guard;
  already covered).
- [ ] Torn/unreadable lock JSON → `Acquire` **takes over** (regression guard;
  already covered).
- [ ] The default probe swallows `ArgumentException` and `InvalidOperationException`
  (→ dead, take over) and `Win32Exception` / `NotSupportedException`
  (→ unreadable, refuse); an exited process (`HasExited`) is treated as dead — an
  uncaught probe exception must never crash `Acquire` (that would reintroduce the
  very "backend exited before reporting a port" failure this fixes).
- [ ] `Program.cs` call site compiles unchanged (probe parameter defaulted);
  `started-at` value semantics unchanged (no migration).

## Test plan (TDD)

All tests live in `tests/PRism.Core.Tests/Hosting/LockfileManagerTests.cs`,
exercising the public `Acquire` with an injected fake `probeProcess` where noted.

**Red-on-main proof.** One regression test reproduces the bug through the
**existing public signature** (no seam), so it compiles and runs against a clean
`origin/main`:

```
Acquire_recovers_from_recycled_PID_when_locked_path_equals_current_path
```

It writes a lockfile with `pid = Environment.ProcessId` (a guaranteed-live PID —
the test runner — standing in for the process the OS recycled the PID into) and
`binary-path = <a fake PRism path that is NOT the test runner's real exe>`, then
calls `Acquire(currentBinaryPath: <same fake PRism path>)`. On `main`, `IsAlive`
compares the two equal fake paths → `true` → throws (RED). After the fix, the real
probe reads the test runner's actual `MainModule` path, which differs from the
fake → stale → takes over (GREEN). Commit-pinned failing output captured for
`## Proof`.

**Seam-based deterministic tests** (fake `probeProcess`), one named test each:
- `Acquire_takes_over_when_live_PID_has_different_real_path` — probe returns a
  readable path ≠ locked → take over.
- `Acquire_throws_when_live_PID_real_path_matches_locked` — probe returns a
  readable path == locked → throws.
- `Acquire_throws_when_live_PID_identity_unreadable` — probe returns
  `RunningProcessInfo(null)` → throws (conservative policy).
- `Acquire_takes_over_when_probe_reports_dead_PID` — probe returns `null` → take
  over (seam mirror of the real dead-PID guard).

**Default-probe robustness test.** A test that drives the *real* default probe
(no injection) against `Environment.ProcessId` with a fake locked path, asserting
take-over (this is the red-on-main test above) — confirms the real `Process`
path read works for the own-process case on the primary target.

**Preserved regression guards** (existing tests — expected to stay green
**unmodified** under Approach A, since path-only ignores `started-at`):
- `Acquire_succeeds_when_no_lockfile_exists`
- `Acquire_throws_when_another_live_PRism_holds_the_lock` — lockfile records the
  test runner's real `ProcessPath` + real `ProcessId`; the real probe reads the
  same path → match → throws. ✓ (unchanged)
- `Acquire_recovers_from_dead_PID`
- `Acquire_recovers_from_PID_alive_but_different_binary` — locked path
  `/totally/different/binary` ≠ the runner's real `MainModule` path → take over.
  ✓ (now passes for the *right* reason — real path comparison, not metadata)
- `Acquire_recovers_from_torn_json`
- `Dispose_removes_the_lockfile`

> If `Environment.ProcessPath` and `Process.GetCurrentProcess().MainModule.FileName`
> ever diverge for the test host (they should not on Windows), the
> `Acquire_throws_when_another_live_PRism_holds_the_lock` guard is the canary — it
> would flip to take-over. Verified during implementation before relying on it.

## Risk classification

**Hands-off.** No risk surface from `architectural-invariants.md` is touched:

- **Not a desktop sidecar seam.** `LockfileManager` is the single-instance guard
  present in both web and desktop builds; it is **not** one of the four
  `PRISM_SIDECAR`-gated seams (`SidecarMode`, `ParentLivenessProbe`/`Watchdog`,
  `HostHeaderCheckMiddleware`, `127.0.0.1` bind). The issue notes it surfaced
  *under* the desktop shell but is independent backend logic.
- **Not a data migration / persisted schema.** Approach A makes **no change** to
  the lockfile format or to the `started-at` value semantics — only the *liveness
  comparison* changes. The lockfile is ephemeral anyway (deleted on clean exit,
  recreated each launch, torn files taken over). No migration, and (unlike the
  rejected Approach B) no transitional upgrade hazard.
- **Not a security boundary.** Stated in the issue. No host-header check, bind
  address, or secret handling is touched. The ambiguous-case policy is chosen to
  be *no less safe than today*, never to open a concurrency window.
- **Not B1 UI-visual.** Labeled `bug`, not `design`; acceptance is mechanically
  assertable in unit tests, no eyeball judgment.

## Scope

- **In:** `IsAlive` rewrite (real executable path vs locked path + conservative
  ambiguous-case policy), `RunningProcessInfo` record + default real probe
  (mirroring `ParentLivenessProbe`'s 4-exception catch set) + optional
  `probeProcess` parameter on `Acquire`, and the tests above.
- **Out:** Recording `Process.StartTime` (rejected Approach B); any lockfile
  format/value change; in-app guidance pointing users at a stale lockfile
  (separate UX concern); refactoring `ParentLivenessProbe` to share a probe type
  (the catch-set pattern is reused conceptually, not extracted — premature for one
  call site, but noted so a future consolidation doesn't add a third probe shape).
- **Residual (documented, accepted):** A dead PRism's PID recycled onto *another
  live process at the identical PRism exe path* reads as "another live PRism" →
  refuse. That other process is effectively a second PRism, for which refusing is
  the correct outcome; path-only does not (and need not) distinguish it.
- **Cross-platform note:** `Process.MainModule` is reliable for own-user processes
  on Windows (the primary target). On macOS/Linux it can throw or be restricted;
  those throws route through the **unreadable → refuse** policy, which is no less
  safe than today. Linux is P4 with documented degraded behavior already.
```

