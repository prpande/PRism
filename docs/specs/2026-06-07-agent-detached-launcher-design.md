# Agent-friendly detached launcher (`scripts/serve-detached.ps1`): Design

**Slice**: dev-tooling, out-of-band — not a roadmap slice. A new helper script plus two small additive switches on [`run.ps1`](../../run.ps1). Sibling in spirit to [`docs/specs/2026-05-06-run-script-reset-design.md`](2026-05-06-run-script-reset-design.md).
**Date**: 2026-06-07.
**Status**: Implemented — PR [#269](https://github.com/prpande/PRism/pull/269). Tracking issue: [#266](https://github.com/prpande/PRism/issues/266).
**Source authorities**: [`run.ps1`](../../run.ps1) is the production launch script this builds on; [`PRism.Web/Program.cs`](../../PRism.Web/Program.cs) (port resolution, `ApplicationStarted` ready line, `LockfileManager.Acquire` *before* bind, `--dataDir` echoed verbatim), [`PRism.Web/Endpoints/HealthEndpoints.cs`](../../PRism.Web/Endpoints/HealthEndpoints.cs) (`/api/health` → `{ port, version, dataDir }`), [`PRism.Web/Middleware/SessionTokenMiddleware.cs`](../../PRism.Web/Middleware/SessionTokenMiddleware.cs) (`/api/health` is auth-exempt), and [`.ai/docs/parallel-agent-testing.md`](../../.ai/docs/parallel-agent-testing.md) (the `(port, dataDir)` band) define the contract this script consumes.

---

## 1. Goal

Give a coding agent **one command** that brings the PRism dev server up as a **long-lived, detached process** and returns **only when the server is actually answering HTTP** — then reports a structured handle (`PID`, `URL`, `log`, `dataDir`) the agent can act on. Today there is no such command; agents repeatedly waste a turn (or a whole session) failing to spawn the server. The five root causes, all empirically confirmed in a live session on 2026-06-07:

1. **`run.ps1` is foreground-blocking.** Its final `dotnet run` ([`run.ps1:244`](../../run.ps1)) never returns. A one-shot agent tool call either hangs to timeout or has to background it.
2. **Harness-backgrounded children get reaped.** `run_in_background` / `Start-Process` children die when the harness job object is torn down. The only detach that survives on Windows is `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` (WMI), which spawns outside the job object.
3. **The silent killer: WMI does not run a shell.** `Win32_Process.Create` execs a command line directly — no `cmd`/`pwsh` parsing layer. Redirection operators (`*>`, `2>&1`, `>`) in that command line become *literal arguments* to `pwsh`/`dotnet`, so the launch dies with an empty log and no error. The fix is to spawn `pwsh -File wrapper.ps1` where the **wrapper script owns the redirection internally** (`*>> $log` works correctly inside a real shell).
4. **`run.ps1` runs `npm ci` unconditionally** ([`run.ps1:222`](../../run.ps1)) — a full, deterministic reinstall that is slow and **hard-fails on `package-lock.json` drift** (common in fresh worktrees). So agents skip `run.ps1` entirely and hand-roll `dotnet run`, losing the `--no-launch-profile` / `--urls` / env-restore correctness baked into it.
5. **No machine-checkable readiness signal.** Agents must hand-roll port polling, and a naive poll can falsely attach to *another* agent's server already on that port.

`serve-detached.ps1` removes all five: it detaches via WMI + a wrapper that owns its own redirection (2, 3), delegates the launch to `run.ps1` so it inherits every launch-correctness fix (1), offers `-SkipBuild` to dodge the `npm ci` tax (4), and HTTP-health-gates against `/api/health` with a canonical dataDir match (backed by the host's single-instance lockfile) before returning a structured handle (5).

### Which script does an agent use? (the one-rule)

This work creates a second entry point, so the boundary must be unambiguous, not a footnote:

> **Non-interactive agents launch with `serve-detached.ps1`. A human at a console who wants to watch the server runs `run.ps1`.**

`serve-detached.ps1` becomes **the** canonical agent launch command. Implementation **rewrites** (not appends to) the [`parallel-agent-testing.md`](../../.ai/docs/parallel-agent-testing.md) § "Launch the app" section so its primary example is `serve-detached.ps1`, with foreground `run.ps1` demoted to the human-watching case. A pointer placed *next to* the old "use `run.ps1`" instructions would be two instructions; the goal is one. (Doc-map update tracked in § 7.)

### Why a new script instead of changing `run.ps1`

`run.ps1`'s contract is **foreground**: a human runs it and watches the console. Detached launch is a *different execution model* (a non-interactive agent that needs the call to return). Folding both into one script would either break the human-facing semantics or bolt a second mode onto a script that is already doing build + reset + launch. So `serve-detached.ps1` **builds on** `run.ps1` (delegates build and launch to it) rather than replacing it. The only changes to `run.ps1` are two additive, behavior-preserving switches (§ 4.1).

### Why this didn't fall out of the #217 / #228 parallel work

[#217 / #228](../../.ai/docs/parallel-agent-testing.md) parameterized `-Port` / `-DataDir` and stopped `launchSettings.json` from clobbering `--urls` — i.e. they made `run.ps1` parallel-**safe** (collision-free). That is orthogonal to causes 1–5 (blocking / detach / `npm ci` / readiness). `run.ps1` was never adapted to the *agent execution model*, so agents still route around it. This script closes that gap and stays parallel-aware (it honors the same `(port, dataDir)` band).

## 2. Scope

### In scope

- A new `scripts/serve-detached.ps1` with two modes — **launch** (default) and **`-Stop`** (teardown) — plus a launch-mode-only **`-SkipBuild`** fast path.
- Detach via `Invoke-CimMethod Win32_Process Create` spawning `pwsh -NoProfile -File <wrapper>` where the wrapper owns `*>> $log` (causes 2 + 3).
- The wrapper delegates the actual launch to `run.ps1 -SkipBuild` so the `--no-launch-profile` / `--urls` / `--dataDir` / `ASPNETCORE_ENVIRONMENT`-restore logic lives in exactly one place (cause 1).
- A synchronous, foreground **build step** before detaching (unless `-SkipBuild`), delegated to `run.ps1 -BuildOnly` — which builds **both** the frontend (`npm ci; npm run build`) **and** the backend (`dotnet build`) — so build failures (cause 4, and C#/restore failures) surface *immediately to the caller* instead of being buried in a detached log (§ 4.1).
- An **HTTP health gate** (§ 4.6): poll `http://localhost:<Port>/api/health` until it returns `200` and the response's `dataDir` matches the launcher's canonical `-DataDir` — or a timeout elapses (cause 5). The host runs `LockfileManager.Acquire` *before* binding the port, so at most one backend per store can ever be listening; a `200` + canonical-dataDir match therefore identifies the sole legitimate server for that store, with no separate process-ancestry check needed (§ 4.5).
- A **structured result** emitted on success: a PowerShell object `{ Pid; Url; Log; DataDir; Version }` (and the same fields in a pidfile). `Version` is informational only (see § 4.6 — it is not a staleness guard). On failure: a clear message that **distinguishes an empty log (wrapper never wrote — a launch-shell / execution-policy / unwritable-log error) from a populated log (server started but never answered)**, the relevant log tail, and a non-zero exit.
- **Canonical dataDir handling** (§ 4.6): resolve `-DataDir` to a single long-path absolute string *once* on entry, and use that exact string everywhere (passed to `run.ps1`, used for the health match, and — because `LockfileManager` keys its lock on the literal path — the thing that keeps the single-instance guard sound).
- **Parallel-agent awareness**: honor `-Port` / `-DataDir` and the `5200 + N` band from [`parallel-agent-testing.md`](../../.ai/docs/parallel-agent-testing.md). Pidfile, wrapper, and log are namespaced under the per-agent canonical `-DataDir`.
- A **pidfile** under `<DataDir>` and a **`-Stop`** mode that tree-kills the launched process — **after verifying the recorded PID still belongs to the expected `pwsh`/`dotnet` process** (PID-recycle guard, § 4.5) — and removes the pidfile, idempotently.
- Two additive switches on `run.ps1`: `-BuildOnly` (build, don't launch) and `-SkipBuild` (launch, don't build), mutually exclusive, with the default (neither) byte-for-byte unchanged from today, and their interaction with `-Reset` specified (§ 4.1).
- A manual smoke checklist (§ 9). No PowerShell test framework is added (same rationale as the reset spec § 8).

### Out of scope

- **macOS / Linux.** The harness-reaping problem (cause 2) and its WMI fix are Windows-specific; on POSIX `setsid` / `nohup` already survive, and `Get-NetTCPConnection` / `taskkill` don't exist there. A cross-platform detached launcher is a separate effort. The script declares `#requires -Version 7` and fails fast on non-Windows (§ 6). (Windows-but-no-WMI environments — locked-down sandboxes, some containers — also fail fast with the same guard message.)
- **Fixing `package-lock.json` drift.** `serve-detached.ps1` surfaces an `npm ci` failure synchronously and tells the caller to resolve the lockfile or re-run with `-SkipBuild`; it does not silently `npm install` or "repair" the lockfile (that would hide the drift the memory note warns about).
- **Auto-port selection for the detached launch.** `run.ps1` always pins a port (`-Port`, default 5180); true auto-port is a deferred `run.ps1` enhancement noted in `parallel-agent-testing.md`. `serve-detached.ps1` inherits the pinned-port model. **Path-dependency note:** pinning the port is *why* this script needs the § 5 collision-management surface (port-in-use branching, `-Force`); an eventual `run.ps1` auto-port would let `serve-detached.ps1` read the chosen port from the ready line and retire most of § 5 — at the cost of a one-time change to the agent contract this script establishes. Choosing pinned-port now is a deliberate near-term bet, recorded here so the trajectory cost is explicit.
- **`-Reset` forwarding (decided: do not add).** `-Reset` stays on `run.ps1`. An agent that wants a clean store runs `./run.ps1 -Reset Token -DataDir <store>` (or `Full`) *before* `serve-detached.ps1`. Forwarding reset into the launcher would couple it to the guarded destructive path and risk a double-reset (the wrapper's launch invocation re-running `-Reset Full` would wipe the store out from under the just-built server — § 4.1). The launcher never deletes the dataDir. (This was an open question in an earlier draft; closed here per scope-guardian + feasibility review.)
- **A long-running supervisor / restart-on-crash.** This brings the server *up* and confirms readiness once. It does not babysit, restart, or health-monitor after the initial gate. If the server later crashes, `-Stop` cleans up the stale pidfile and the agent relaunches.
- **Replacing the Playwright `webServer` boot.** The e2e configs own their own server lifecycle; this script is for the *interactive dev / dogfooding* server an agent drives by hand.
- **The desktop (Electron) shell.** The shell spawns its own sidecar with its own lifecycle (`parallel-agent-testing.md` § Desktop); this script targets the browser-tab `dotnet run` server only.
- **Hardening against a same-user local attacker.** The wrapper, log, and pidfile live under a user-private `-DataDir`. An attacker who can already execute code as the same user can edit `run.ps1`, `node_modules` postinstall scripts, or the wrapper directly — wrapper-substitution adds nothing to that pre-existing capability, so per-launch hashing/signing of the wrapper is out of scope. The threat model is the same single-user, loopback-only model as the rest of PRism (`spec/02-architecture.md` § 6.2). The randomized launch-lock + the PID-identity guard (§ 4.5) are the only same-machine robustness measures, and they exist for *accident* (recycled PIDs, double-fire), not for an adversary.

## 3. Parameter shape

```powershell
# Launch (default mode), foreground build then detach, gate on health:
scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0

# Fast path: skip the foreground build (node_modules + wwwroot already current):
scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 -SkipBuild

# Pass-through app args (after the launcher's own params) flow to dotnet run:
scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 --no-browser

# Teardown:
scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-wt-0

# Force past an occupied port (kills whatever holds it — opt-in, see § 5):
scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 -Force
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `-Port` | `[ValidateRange(1,65535)] int` | `5180` | Same validation as `run.ps1`. Caller uses `5200 + N` for parallel agents. |
| `-DataDir` | `string` | `%LocalApplicationData%\PRism` | Same default as `run.ps1`. Canonicalized on entry (§ 4.6) and used as the namespace for the pidfile / wrapper / log. |
| `-SkipBuild` | `switch` | off | Launch mode only. Skip the foreground `run.ps1 -BuildOnly` step. For the explicit opt-in case where the build is already current — **not** the default; see the caution in § 4.1. |
| `-Stop` | `switch` | off | Teardown mode; reads `<DataDir>` pidfile and tree-kills. Mutually exclusive with launch-only params (`-SkipBuild` / `-Force` / `$DotnetArgs`), rejected at parse (§ 6). |
| `-Force` | `switch` | off | Launch mode only. On an occupied `-Port` whose occupant is **not** our own healthy server, kill the occupant and proceed. Default is to fail (§ 5). |
| `-TimeoutSec` | `[ValidateRange(5,600)] int` | `90` | Health-gate budget. Exposed (not a hidden constant) because cold-start time varies widely — a first-run JIT/restore on a loaded machine or constrained sandbox can exceed 90 s, and an agent that hit the timeout should be able to retry with more budget rather than give up (which is the wasted-turn failure this script exists to prevent). |
| `$DotnetArgs` | `ValueFromRemainingArguments string[]` | — | Pass-through app args (e.g. `--no-browser`), forwarded verbatim through `run.ps1` to `dotnet run`'s app-arg section. |

Rationale for matching `run.ps1`'s `-Port` / `-DataDir` names and defaults: an agent that has read `parallel-agent-testing.md` already knows them; divergent names would be a fresh thing to learn and a fresh way to get it wrong.

## 4. Design

### 4.1 `run.ps1` changes — two additive switches

`run.ps1` currently does, unconditionally: build (`npm ci; npm run build`) then launch (`dotnet run …`). Two switches split those phases without changing the default:

```powershell
param(
    # … existing params (Reset, Port, DataDir, DotnetArgs) …
    [switch]$BuildOnly,   # build (frontend + backend), then return WITHOUT launching
    [switch]$SkipBuild    # launch WITHOUT building (assumes a current build)
)
# … existing -Reset block runs first, exactly as today …
if ($BuildOnly -and $SkipBuild) { throw "-BuildOnly and -SkipBuild are mutually exclusive." }

Push-Location $PSScriptRoot
try {
    if (-not $SkipBuild) {
        Push-Location frontend
        try { npm ci; npm run build } finally { Pop-Location }
        dotnet build --configuration Debug      # so C#/NuGet failures surface here, not post-detach
    }
    if ($BuildOnly) { return }
    # … existing env-restore + dotnet run launch, unchanged …
} finally { Pop-Location }
```

- **Default (neither switch)** → build + launch. The only behavioral addition versus today is the explicit `dotnet build` in the build phase; `dotnet run` would have built incrementally anyway, so this is a no-op on output and merely moves the .NET compile *earlier and into the foreground*. Existing callers and `parallel-agent-testing.md` examples are otherwise unaffected.
- `serve-detached.ps1`'s **foreground build** calls `run.ps1 -BuildOnly …`. Because `-BuildOnly` now runs `dotnet build`, a C#/restore error fails **synchronously, before any detach** — closing the gap where `dotnet run`'s implicit build would otherwise fail inside the detached wrapper and surface only as a health-gate timeout.
- `serve-detached.ps1`'s **detached wrapper** calls `run.ps1 -SkipBuild …`. Its `dotnet run` still performs an incremental build, but everything is already built (foreground), so that pass is a fast no-op and cannot introduce a new compile error.

**`-SkipBuild` is an explicit opt-out of the synchronous-build guarantee, not the default.** When a caller passes `serve-detached.ps1 -SkipBuild`, no foreground build runs at all; a frontend *or* .NET error then surfaces post-detach as a health-gate timeout (read-the-log). Use `-SkipBuild` only when the build is known-current (e.g. a relaunch with no source edits). The § 3 table and the docs frame it this way deliberately — the edit→relaunch loop, where the build is exactly *not* current, must use the default build path.

**`-Reset` interaction.** The existing `-Reset` block runs before the build/launch split, so it fires under `-BuildOnly` and under `-SkipBuild` alike. `serve-detached.ps1` does **not** forward `-Reset` (§ 2, decided). If a future change ever did, reset must be attached to the `-BuildOnly` foreground call **only**, never the `-SkipBuild` wrapper call — otherwise `-Reset Full` would run twice, the second time wiping the store out from under the launched server.

This makes `run.ps1` the single source of truth for *both* the build commands and the launch line. `serve-detached.ps1` adds **zero** duplicated build/launch logic — it only adds detachment, the health gate, and process bookkeeping. (See § 8 for the maintenance tradeoff of these two switches versus a self-contained build in `serve-detached.ps1`.)

### 4.2 Launch flow

```
1. Guard: Windows + pwsh 7 + WMI available (else fail with a clear message). Resolve repo root from $PSScriptRoot\..
2. Canonicalize -DataDir to ONE long-path absolute string (§ 4.6). Create it if absent.
   Compute pidfile / log / wrapper paths under it.
3. Port pre-check (§ 5):
   - Nothing listening on $Port → proceed.
   - Something listening → probe http://localhost:$Port/api/health:
       • healthy AND body.dataDir matches canonical $DataDir → idempotent success (LOUD, § 5): emit a fresh
         { Pid=<port owner>; Url; Log; DataDir; Version } handle (Version from /api/health) PLUS a
         "no rebuild occurred — running server may predate your working tree" warning. Exit 0.
       • healthy but dataDir != $DataDir → another store's server: FAIL (or kill+proceed if -Force).
       • not a health endpoint / no 200      → unknown occupant: FAIL (or kill+proceed if -Force).
4. Build (unless -SkipBuild): run.ps1 -BuildOnly -Port $Port -DataDir $DataDir   [FOREGROUND]
       • non-zero exit (npm ci lockfile drift, or a C#/restore error via dotnet build) → FAIL here, synchronously.
5. Author the wrapper script at <DataDir>\serve-detached.wrapper.ps1 (§ 4.3).
6. Detach: Invoke-CimMethod Win32_Process Create with CommandLine =
       pwsh -NoProfile -ExecutionPolicy Bypass -File "<wrapper>"
   (NO redirection operators in this command line — cause 3). Capture ReturnValue + ProcessId(=WrapperPid).
       • ReturnValue != 0 → FAIL (WMI refused to spawn).
7. Write the pidfile {WrapperPid; Port; Url; DataDir; Log; StartedUtc} (ServerPid added on READY).
8. Health gate: poll http://localhost:$Port/api/health every ~500 ms up to -TimeoutSec:
       • 200 AND body.dataDir matches canonical $DataDir → READY. The host acquires the per-store lockfile
         BEFORE binding (§ 4.6), so any listener answering for this store is the sole legitimate instance —
         no process-ancestry check is needed. Resolve ServerPid as the port owner (§ 4.5), record it, and
         emit { Pid=ServerPid; Url; Log; DataDir; Version }. Exit 0.
       • WrapperPid died before ready → FAIL fast. Diagnose by log state:
            - log empty/absent → "wrapper never wrote — a launch-shell / execution-policy / unwritable-log error."
            - log populated    → print the tail ("server started but exited").
       • timeout → FAIL: same empty-vs-populated log diagnostic + WrapperPid + log path + "port may have been
         taken by another process after the pre-check." Exit non-zero.
```

Step 4 running the build **in the foreground** is deliberate: an `npm ci` (cause 4) or C# compile failure is exactly the opaque, time-wasting failure this script exists to kill. Surfacing it synchronously — before anything detaches — means the agent sees the real error, not a health-gate timeout against an empty log.

**Why no process-ancestry gate.** An earlier draft additionally required the listener to be within the spawned `WrapperPid` tree, to reject a foreign process that won the port. Two round-2 findings retired that: (a) on Windows `ParentProcessId` is not updated when an intermediate parent (the wrapper `pwsh`) exits, so a perfectly healthy server *this* launch started could fail the upward walk and be wrongly rejected — the exact wasted turn the script prevents; and (b) it is unnecessary — `Program.cs` calls `LockfileManager.Acquire` before binding the port, so a *same-store* foreign process cannot reach a listening state, and a *different-store* process reports a different `dataDir` (the gate keeps polling, our `dotnet` then fails to bind the taken port and dies, surfacing as the WrapperPid-died diagnostic). So `health 200 + canonical-dataDir match` is a complete identity proof on its own.

### 4.3 The wrapper script (cause 3 fix)

`serve-detached.ps1` writes a tiny wrapper to `<DataDir>\serve-detached.wrapper.ps1` each launch (overwritten; it is disposable):

```powershell
# serve-detached.wrapper.ps1 — owns its own redirection so the WMI command line has none.
$ErrorActionPreference = 'Stop'
$log = '<DataDir>\serve-detached.log'
"=== serve-detached launch @ <StartedUtc> port <Port> ===" *>> $log   # banner; APPEND, do not truncate
& '<repoRoot>\run.ps1' -Reset None -SkipBuild -Port <Port> -DataDir '<DataDir>' --no-browser <DotnetArgs> *>> $log
```

- The redirection (`*>> $log`) lives **inside** this real `pwsh` process, where it is parsed as a redirection, not passed as a literal arg. This is the whole point of the wrapper (cause 3).
- It calls `run.ps1` by **absolute path**; `run.ps1` does its own `Push-Location $PSScriptRoot`, so the wrapper needs no `Set-Location`. (`Win32_Process.Create` is still given `CurrentDirectory = <repoRoot>` defensively.)
- **`-Reset None` is named explicitly** (impl-discovered 2026-06-07, verified on pwsh 7.5). `run.ps1`'s `$Reset` is the position-0 parameter with a `ValidateSet`; a bare leading `--no-browser` with no named `-Reset` binds *positionally* to `$Reset` and fails its `ValidateSet` (a `--` separator does not rescue it). Naming `-Reset None` keeps `$Reset` bound so `--no-browser` / `<DotnetArgs>` flow to `run.ps1`'s `ValueFromRemainingArguments`. `None` is the no-op reset, so the wrapper never triggers the destructive `-Reset` path (consistent with §2's "launcher never deletes the dataDir"). This is the established launch convention (`run.ps1 -Reset None --no-browser`), now made mandatory for the wrapper.
- `--no-browser` is always injected: a detached, non-interactive WMI session must never try to open a browser. Any caller `$DotnetArgs` are appended *after* it; `run.ps1` already places `--dataDir $DataDir` before `@DotnetArgs`, so the `CommandLineOptions` next-token-swallow quirk ([`Program.cs:45`](../../PRism.Web/Program.cs)) cannot consume the dataDir.
- **The log is appended, not truncated** (`*>> $log`), with a per-launch `=== … ===` banner delimiting runs. Truncating per launch would erase the prior run's diagnostics the moment an agent relaunches — and a *failed* launch emits no handle, so the log is the only record of why it failed; a crash-loop would otherwise destroy its own evidence on each retry. The launcher caps the log (roll/trim when it exceeds a few MB) so append growth is bounded. Freshness is established by the banner + the health gate, not by truncation.
- Values are interpolated into the file at author time (paths are absolute and script-controlled — see the same-user threat-model note in § 2).
- **Sensitivity:** `serve-detached.log` is **raw `dotnet`/Kestrel stdout/stderr** and bypasses the structured `FileLoggerProvider`'s `LogScrub` / `SensitiveFieldScrubber`. Any secret printed to the console (an error dump, a future debug line) lands here in plaintext. `%TEMP%`/`%LocalApplicationData%` are user-private, so this is defense-acceptable, but the file is added to the `-Reset Token` cleanup list in `run.ps1` (alongside `PRism.tokens.cache`) and § 9 / the docs flag it as unscrubbable — do not share or persist it beyond the session.

### 4.4 Detach mechanism

```powershell
$cmd = "pwsh -NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmd; CurrentDirectory = $repoRoot }
if ($res.ReturnValue -ne 0) { throw "WMI Win32_Process.Create failed (ReturnValue=$($res.ReturnValue))." }
$wrapperPid = [int]$res.ProcessId
```

`Win32_Process.Create` spawns **outside** the harness job object, so the process survives the tool call returning (cause 2). `ReturnValue` is `0` on success; any other value is a hard failure surfaced to the caller. Note `ReturnValue == 0` only confirms the OS *created* the process — it does **not** confirm the wrapper script ran or wrote anything, which is why the failure diagnostics in § 4.2 step 8 explicitly cover the spawned-but-died-silently case.

`-ExecutionPolicy Bypass` is required because the wrapper is an unsigned, ephemeral file written at runtime; there is nothing to sign. Bypass relaxes the *script execution policy* only — it does **not** circumvent AppLocker / WDAC. On a machine where those enforce code integrity at the OS layer, the wrapper launch will be blocked, and the failure surfaces as a step-9 "wrapper never wrote" diagnostic. (Such machines are not the target environment; noted so the failure is interpretable.)

### 4.5 The PID problem, identity, and teardown

The process tree is **wrapper-`pwsh` → `dotnet run` → `PRism.Web`** (verified: on .NET 10, `dotnet run` spawns the app as a child; it does not exec-replace). `Win32_Process.Create` returns the *wrapper* PID; the actual listener is two levels down. The script records both:

- **`WrapperPid`** — the WMI return value, the root of the tree.
- **`ServerPid`** — resolved *after* the health gate as the port owner. Because the app binds the `localhost` hostname, Kestrel listens on **both** `127.0.0.1` and `::1`, so `Get-NetTCPConnection -LocalPort $Port -State Listen` returns **two** rows (one per address family) with the **same** `OwningProcess`. Resolve defensively:

  ```powershell
  $serverPid = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess |
               Select-Object -Unique | Select-Object -First 1
  ```

  No process-ancestry verification is performed (see § 4.2 "Why no process-ancestry gate" and § 4.6): the `LockfileManager.Acquire`-before-bind invariant already guarantees that whatever is listening for the canonical store is the sole legitimate instance, so the port owner *is* the right `ServerPid` to record and to report as the handle's `Pid`.

`-Stop` tree-kills from the wrapper root so all three layers die — **but guards against PID recycling first.** PRism has a documented history here (the `LockfileManager` recycled-PID crash, #107): a 32-bit PID space recycles fast, so a dead `WrapperPid`/`ServerPid` may now belong to an unrelated process. Before any `taskkill`:

```powershell
# Only kill if the PID still names the process we recorded.
$p = Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue
if ($p -and $p.Name -eq 'pwsh') { taskkill /PID $wrapperPid /T /F }
```

`/T` kills the entire tree (`dotnet run` + the app child). If the name doesn't match (recycled) or the process is gone → treat as "not running", clean up the pidfile, exit 0 (idempotent). If `WrapperPid` is gone but `ServerPid` still listens and still names `PRism`/`dotnet` (the re-parented case) → `taskkill /PID <ServerPid> /F` with the same identity guard. Then remove the pidfile.

The `-Force` port-kill is a *different* check, not the `-Stop` name guard: a `-Force` occupant is foreign, so there is no name *we* recorded to compare against. Instead, defend against the recycle TOCTOU by re-reading the occupant in a tight window immediately before killing — `Get-NetTCPConnection -LocalPort $Port -State Listen` → `OwningProcess` → `Get-Process` name — confirm the listener is still the same process just surfaced to the caller, then `taskkill /PID <pid> /F`. If the port is already free on the re-read (the occupant exited on its own), skip the kill and proceed; if a *new* occupant appeared, re-probe rather than firing `taskkill` at a stale PID.

### 4.6 Identity: canonical dataDir + single-instance lockfile (cause 5)

`/api/health` is the readiness gate because it is the **only** endpoint guaranteed reachable from a bare PowerShell `Invoke-WebRequest`:

- It is a **GET**, so `OriginCheckMiddleware` (which 403s mutating verbs with no `Origin`) does not apply.
- It is **auth-exempt** — `SessionTokenMiddleware.IsLivenessEndpoint` short-circuits `/api/health` before the session-token check. (Under the `run.ps1` launch, `ASPNETCORE_ENVIRONMENT=Development` also disables session enforcement entirely; the liveness carve-out makes the gate robust even if that ever changes.)
- Its body `{ port, version, dataDir }` is built from the values the host resolved at startup ([`Program.cs`](../../PRism.Web/Program.cs) `MapHealth(dataDir, port)`). **The `dataDir` is echoed verbatim** — `Program.cs` reads `--dataDir` via `CommandLineOptions.GetValue` and does *not* canonicalize it. So whatever string the launcher passes is exactly what comes back.

**The canonicalization rule.** A naive `body.dataDir == $DataDir` string compare is fragile and, worse, unsound:

- *False timeout:* `%TEMP%` frequently expands to an 8.3 short form (`C:\Users\PRATY~1\AppData\Local\Temp`). `[IO.Path]::GetFullPath` canonicalizes `.`/`..`/separators but does **not** expand 8.3 names or normalize casing — so the launcher's compare-side and the passed-side can differ, the equality never holds, and the gate waits out the full `-TimeoutSec` against a healthy server, then reports failure. The agent concludes the launch failed and may relaunch.
- *Unsound single-instance guard:* `LockfileManager.Acquire` computes its lock path as `Path.Combine(dataDir, "state.json.lock")` from the **raw** string. If launch #1 passes the long form and launch #2 passes the short form of the *same* directory, the health match fails to recognize #1's server **and** the two lock paths differ — so #2's `Acquire` succeeds and two backends write one physical store, the exact corruption the lock exists to prevent. The idempotent branch's "Acquire would catch it anyway" assumption only holds if both invocations key on identical bytes.

Fix: **resolve `-DataDir` to one canonical long-path absolute string on entry** (e.g. `(Get-Item -LiteralPath $DataDir).FullName` after creating the directory, or a `GetLongPathName` P/Invoke — *not* `GetFullPath` alone), and thread *that exact string* through everywhere: the `run.ps1` call (→ `--dataDir` → `/api/health`), the health compare, and the pidfile. Because every consumer keys on the same bytes, the lock path and the health identity agree by construction. The compare is then `body.dataDir -ieq $canonical` (ordinal-ignore-case, trailing separator trimmed) as belt-and-suspenders. Any agent that passes a denormalized form of the same store converges to the same canonical string on entry, so a second launch is correctly recognized as a reattach (or correctly blocked by the lock), never a second backend.

**Single-instance is the second proof.** The dataDir match proves *some* process answering on the port reports our store; the `LockfileManager` invariant proves there can be only one. [`Program.cs:177`](../../PRism.Web/Program.cs) calls `LockfileManager.Acquire(dataDir, …)` *before* `app.Urls` binds the port, so any process that is *listening* for a given store necessarily holds that store's lock — it is the sole legitimate backend for it. Therefore `health 200 + canonical-dataDir match` uniquely identifies the right server with no need for a process-ancestry walk (which round-2 review showed is both unreliable — `ParentProcessId` survives a parent's exit stale — and redundant given this invariant; see § 4.2 "Why no process-ancestry gate"). The double-fire case (two launches both pass the port pre-check) resolves the same way: both wrappers spawn, the second backend to start fails `Acquire` and exits before binding, so exactly one listener exists; both launchers' gates see it, the dataDir matches, and reporting it is correct. A `-Force` kill that didn't fully release the port is handled by the `-Force` re-read-before-kill window (§ 4.5), not here.

`version` is surfaced in the handle because `/api/health` already returns it (free) and it aids "is this the binary I think?" debugging. **It is explicitly not the staleness mechanism** — a dev binary's assembly version usually does not change between builds on a feature branch, so it cannot reliably tell an agent the running server predates an edit. Staleness is handled by the loud idempotent warning (§ 5), not by asking the agent to eyeball a version.

### 4.7 The pidfile

`<DataDir>\serve-detached.pid`, JSON, UTF-8 no BOM (reusing `run.ps1`'s `Write-Utf8NoBom` pattern):

```json
{
  "wrapperPid": 12345,
  "serverPid": 12377,
  "port": 5200,
  "url": "http://localhost:5200",
  "dataDir": "C:\\Users\\…\\Temp\\PRism-wt-0",
  "log": "C:\\Users\\…\\Temp\\PRism-wt-0\\serve-detached.log",
  "startedUtc": "2026-06-07T12:34:56Z"
}
```

Keying the pidfile on the canonical `<DataDir>` (not a global location) means parallel agents (distinct stores) never collide and `-Stop -DataDir <dir>` is unambiguous — it mirrors `LockfileManager`'s per-store model. A **stale pidfile** (its PIDs no longer alive *or* recycled to a different process name, § 4.5) is detected on the next launch (overwrite) and on `-Stop` (clean up, report "not running").

**Same-store double-fire** (an agent double-firing, or a human + agent both on wt-0) is *not* defended by a separate launcher-level lock. An earlier draft added a `CreateNew` launch-lock file; round-2 review retired it for two reasons: (a) the launcher runs **foreground in the harness** (the build and the up-to-`-TimeoutSec` health poll), which is exactly the reap-prone model of cause 2 — a launcher killed mid-flight never runs its `finally`, leaving an orphaned sentinel that wedges *every* future launch with "launch in progress" forever, and the lock carried no PID/age to recover from (unlike the pidfile); and (b) it is unnecessary. The worst outcome of a double-fire is a transient: both launches write the (byte-identical) wrapper, both spawn, the second backend fails `LockfileManager.Acquire` before binding so only one listener ever exists, and the last writer's pidfile may carry a now-dead `WrapperPid`. That stale `WrapperPid` is exactly what the next launch / `-Stop` already detects and recovers (the `ServerPid` fallback in § 4.5 still teardowns the live listener). A one-retry inconvenience, not corruption — not worth a primitive whose own failure mode (the orphan wedge) is worse than the race it prevents.

## 5. Open decision (resolved with rationale): port already in use

**Question.** When `-Port` is already bound, do we kill the occupant or refuse?

**Decision: FAIL by default; kill only on opt-in `-Force`; with one idempotent exception.** On an occupied port the script probes `/api/health` and branches:

| Occupant | Default behavior | With `-Force` |
|---|---|---|
| Our own healthy server (health `200`, `dataDir` matches canonical) | **Success, idempotent — but LOUD** (see below). No kill, no rebuild. Exit 0. | Same (already what we want; nothing to force). |
| A *different* store's PRism (health `200`, `dataDir` differs) | **FAIL** — "port 5200 is serving a different PRism store (`<their dataDir>`); pick another port (`5200 + N`) or pass `-Force` to kill it." | Kill the occupant via the § 4.5 `-Force` re-read-before-kill window, then proceed. |
| Unknown / non-PRism (no `200`) | **FAIL** — "port 5200 is held by PID `<n>` (`<process name>`, not a PRism health endpoint); free it or pass `-Force`." | Kill the occupant (name surfaced first) via the § 4.5 `-Force` re-read-before-kill window, then proceed. |

**Why fail-by-default.** Blindly killing whatever holds the port directly violates the parallel-agent invariant: the most likely occupant of a pinned port is *another agent's server* (or the human's own dogfooding session). Silently killing it would clobber a peer's in-flight work — the exact cross-session collision [#217](../../.ai/docs/parallel-agent-testing.md) was built to prevent. The default must be safe; destruction must be explicit.

**Why `-Force` exists (and why it is not removed).** With the `5200 + N` band, a *legitimate* collision between two well-behaved agents is rare — which raised the question (scope-guardian review) of whether `-Force` is needed at all, since the wedged-own-server case is covered by the idempotent branch and `-Stop`. It is retained deliberately: the residual scenario it serves is **a foreign or non-PRism process squatting the pinned port**, or a *different-store* PRism the operator knowingly wants to evict — neither of which the idempotent branch or `-Stop` (which only knows *this* store's pidfile) can clear. `-Force` is the single, explicit, opt-in escape hatch for "I know what's there and I want the port," and it surfaces the victim's process name before killing. (The owner requested this shape directly.)

**Why the idempotent exception — and why it is LOUD.** "Run `serve-detached` again to make sure it's up" is a natural agent action, and a re-launch against the *same* store while healthy would otherwise waste a build and be blocked by `LockfileManager.Acquire` anyway. Returning the already-running handle is the **repeatable** behavior the goal asks for. But the dominant intent behind a relaunch is often "pick up my latest build," and silent reattach would serve stale code while reporting green — a worse failure than a port error because it surfaces later as "my change isn't taking effect." So the reattach path **emits an explicit warning**: *"Reattached to a server already running for this store; no rebuild occurred — it may predate your working tree. Run `serve-detached.ps1 -Stop -DataDir <d>` then relaunch to refresh."* Idempotent success stays the default (refusing would make benign "is it up?" checks fail), but the staleness tradeoff is made loud rather than hidden behind the `version` field.

This is the only genuinely open *product* decision in the design; everything else in § 4 is mechanism.

## 6. Error handling & guards

- **Platform / capability guard.** `#requires -Version 7`; an explicit `if (-not $IsWindows) { throw }` pointing at the POSIX-out-of-scope note (§ 2), and a guard that WMI (`Invoke-CimMethod Win32_Process`) is reachable — a locked-down sandbox without it fails fast with the same message rather than deep inside the launch.
- **Mode mutual-exclusion.** `-Stop` combined with `-SkipBuild` / `-Force` / `$DotnetArgs` is rejected at the top with a clear message (these only mean something in launch mode). Enforced in-script (not `ValidateSet`) because it spans multiple params.
- **`-DataDir` handling.** `serve-detached.ps1` does **not** delete the dataDir, so it needs no `Assert-SafeResetTarget`. It rejects empty/whitespace early, canonicalizes (§ 4.6), and creates the directory if absent (the host would anyway).
- **Build failure** (step 5) aborts before any detach, with `run.ps1`'s own `npm`/`dotnet build` error surfaced verbatim.
- **WMI spawn failure** (`ReturnValue != 0`) aborts with the return code.
- **Health-gate timeout / early death** distinguishes **empty log** ("wrapper never wrote — a launch-shell / execution-policy / unwritable-log error") from **populated log** ("server started but exited"; print the tail), names the `WrapperPid` and log path, and notes the port may have been taken after the pre-check. Exit non-zero.
- **`$ErrorActionPreference = 'Stop'`** as in `run.ps1`; the port-probe `Invoke-WebRequest` polls are wrapped in `try`/`catch` (a connection-refused during polling is expected, not fatal).

## 7. Parallel-agent contract & doc updates

`serve-detached.ps1` is the canonical agent front for the launch half of `parallel-agent-testing.md`:

```powershell
# worktree N:
scripts\serve-detached.ps1 -Port (5200 + $N) -DataDir "$env:TEMP\PRism-wt-$N"
# … agent does its work against the returned URL …
scripts\serve-detached.ps1 -Stop -DataDir "$env:TEMP\PRism-wt-$N"
```

Everything that file says about the `5200 + N` band, the `5180–5199` auto-pool / `5181` real-flow reservation, and never resetting the default store still holds. Per [`documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md), implementation updates:

- **`parallel-agent-testing.md` § "Launch the app"** — *rewritten* (not appended) so `serve-detached.ps1` is the primary example and the canonical agent command; foreground `run.ps1` is demoted to "human, watching the console." (§ 1 one-rule.)
- **`development-process.md` § "Running parallel agents"** — pointer updated to name `serve-detached.ps1` as the agent launch command.
- **`-Reset Token` cleanup** in `run.ps1` extended to remove `serve-detached.log` (§ 4.3 sensitivity).

## 8. Alternatives considered

- **`serve-detached.ps1` builds directly (no `run.ps1 -BuildOnly`).** *Recommended choice: add the switches; the alternative is viable but weaker.* The foreground build would be a literal `Push-Location frontend; npm ci; npm run build; dotnet build` block inside `serve-detached.ps1`. **For:** keeps `run.ps1` — the script that owns the guarded destructive `-Reset` path — untouched, so its parameter matrix and must-reject combinations don't grow. **Against:** duplicates the build commands (would drift if `run.ps1`'s build changes — e.g. adds a step) and re-implements the env discipline. The build is ~4 lines and changes rarely, so the duplication cost is modest; the deciding factor is single-definition correctness and that the switches are small, additive, and behavior-preserving. *Net: recommend the switches, with the `-Reset × -BuildOnly/-SkipBuild` interaction specified (§ 4.1). The human gate should confirm it is comfortable touching `run.ps1` at all.*
- **Build inside the detached wrapper (no foreground build).** Simplest to write, but reintroduces cause 4's opaqueness: a lockfile-drift `npm ci` or a C# compile failure becomes a health-gate timeout against a log the agent has to dig in. Rejected — surfacing build failure synchronously is a core goal (and is why `-BuildOnly` now runs `dotnet build`, § 4.1).
- **`dotnet exec <dll>` instead of `dotnet run` in the wrapper.** Would flatten the process tree (no `dotnet run` middle layer), simplifying teardown. Rejected: it bypasses `run.ps1` (losing env-restore / `--no-launch-profile` correctness) and diverges from how humans launch. Tree-kill on the wrapper PID + the `ServerPid` fallback handle the extra layer.
- **`Start-Process -WindowStyle Hidden` / `Start-Job` / `run_in_background`.** All reaped by the harness job object (cause 2). This is the empirically-confirmed reason WMI is the only option.
- **A per-launch nonce env var for identity (instead of canonical dataDir + tree check).** The wrapper sets an env var the launcher generates, the app echoes it from a launch-scoped probe — decoupling identity from path canonicalization *and* from store scope, which would also defeat the port-grab race in one stroke. Rejected for now because the app does not echo such a nonce and adding one is a backend change; canonical-dataDir + tree-ancestry (§ 4.6) achieves the same robustness with **no** backend change. Recorded as the cleaner option if a backend echo ever becomes warranted.
- **Named pipe / file "ready" sentinel written by the app instead of HTTP polling.** Requires an app code change; `/api/health` already exists and proves the HTTP stack is actually serving (a sentinel only proves the process reached a line of code). Rejected — HTTP readiness is strictly stronger and needs no backend change.

## 9. Testing

Dev-only orchestration script; no PowerShell test framework is added (same rationale as the reset spec § 8 — Pester would be a heavier dependency than the script it tests, and the C#/HTTP behaviors it drives are already covered by the backend and Playwright suites). Verification is a manual smoke checklist, run once at implementation time and re-run if the script changes.

### Manual smoke checklist

1. **Cold launch → ready handle.** Fresh `-DataDir` under `%TEMP%`. `scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-st`. Verify: the call **returns** (does not hang); it prints a handle with `Pid`, `Url=http://localhost:5200`, `Log`, `DataDir`, `Version`; `Invoke-WebRequest http://localhost:5200/api/health` returns `200` with matching `dataDir`; the process is still alive after the call returned (survived the harness — cause 2).
2. **Redirection actually works (cause 3).** After test 1, the log file is **non-empty** and contains real `dotnet`/Kestrel output (not a `pwsh` "unexpected token `*>>`" error). Regression guard for the silent killer.
3. **`-SkipBuild` fast path.** With a current build, `-SkipBuild` returns ready and **does not** run `npm`/`dotnet build` in the foreground (no build lines in the foreground output; wall-clock noticeably shorter than test 1).
4. **Build failure surfaces synchronously (cause 4).** Introduce `package-lock.json` drift; run *without* `-SkipBuild`. Verify the script **fails in the foreground** with the `npm ci` error, **before** any detached process is spawned (no pidfile, nothing listening).
4b. **.NET build failure surfaces synchronously.** Introduce a C# compile error; run *without* `-SkipBuild`. Verify the foreground `run.ps1 -BuildOnly`'s `dotnet build` fails before detach (no health-gate timeout).
5. **Parallel two-instance.** Launch wt-0 (`-Port 5200 -DataDir …\PRism-wt-0`) and wt-1 (`-Port 5201 -DataDir …\PRism-wt-1`) from two checkouts. Both `/api/health` answer with their own `dataDir`; pidfile/log/wrapper/lock never collide.
6. **`-Stop` teardown.** After test 1, `-Stop -DataDir $env:TEMP\PRism-st`. Verify the listener is gone, the whole tree (`pwsh`/`dotnet`/app) is dead, pidfile removed. Re-running `-Stop` reports "not running", exit 0.
7. **Idempotent re-launch (same store) is LOUD.** With test 1's server up, run the same launch again. Verify it returns the existing handle, exits 0, does **not** kill or rebuild, does **not** hit a `LockfileManager` error, **and prints the "no rebuild occurred — may predate your working tree" warning**.
7b. **Idempotent re-launch with a denormalized dataDir.** Relaunch the same store passing an 8.3 short-name and/or trailing-backslash variant of the path. Verify it is recognized as a reattach (idempotent success), **not** a second listener and **not** a `LockfileManager` collision — proves canonicalization (§ 4.6).
8. **Port-in-use, different store → FAIL (default).** With wt-0 on 5200, launch `-Port 5200` with a *different* `-DataDir`. Verify it **fails** with the "different PRism store" message and does **not** kill the wt-0 server.
9. **`-Force` kills the occupant.** Repeat test 8 with `-Force`. Verify the occupant is killed (its name surfaced first) and the new server comes up on 5200 with the new `dataDir`.
10. **Health-gate timeout diagnostics — populated log.** Force a launch that binds but never serves (or `-TimeoutSec 5` against a cold start). Verify non-zero exit + the **log tail** + wrapper PID + log path.
10b. **Health-gate diagnostic — empty log.** Simulate the wrapper dying before writing (e.g. a deliberately broken wrapper path). Verify the failure message says **"wrapper never wrote — likely a launch-shell error"**, not a misleading empty tail.
11. **Stale pidfile recovery.** Kill the server out-of-band (tree `taskkill`) leaving the pidfile. Next launch on the same store **succeeds** (detects stale PIDs + free port, overwrites); a `-Stop` against the stale pidfile reports "not running" and cleans up.
11b. **Recycled-PID guard.** Hand-edit the pidfile's `wrapperPid` to a live PID of an **unrelated** process (e.g. Notepad). Run `-Stop`. Verify it does **not** kill that process (name mismatch → treated as not-running), cleans up the pidfile.
12. **`run.ps1` default unchanged.** `./run.ps1 -Port 5200 -DataDir $env:TEMP\PRism-st2` (neither new switch) builds and launches in the foreground; the `-BuildOnly`/`-SkipBuild` addition is invisible to existing callers.
13. **Platform guard.** (If a non-Windows shell is available) the script fails fast with the POSIX-out-of-scope message rather than a cryptic `Get-NetTCPConnection` error.
14. **`-Stop` ServerPid fallback (re-parented).** Kill only the wrapper + `dotnet run` layers out-of-band (leave the app alive). Run `-Stop`. Verify the app is killed via the `ServerPid` fallback (with the PID-name guard) and the pidfile is removed.
15. **Same-store double-fire stays single-instance.** Fire two `serve-detached` launches on one `-DataDir` near-simultaneously. Verify exactly **one** listener results (the second backend fails `LockfileManager.Acquire` before binding), both calls return a usable handle (or the loser surfaces a clean failure), and a subsequent `-Stop` tears down the live listener even if the pidfile recorded the loser's dead `WrapperPid`.
16. **`--no-browser` honored detached.** With a pass-through arg supplied, verify the detached server's log shows no `BrowserLauncher` invocation (no browser opens from the WMI session).
17. **`-Force` re-read-before-kill.** Occupy `-Port` with a foreign process, then run `-Force`. Verify the occupant's name is surfaced and it is killed via the tight re-read window; separately, if the occupant exits on its own just before the kill, verify `-Force` does not `taskkill` a recycled PID (proceeds / re-probes instead).

## 10. Acceptance criteria

- A single `scripts\serve-detached.ps1 -Port <p> -DataDir <d>` call **returns** (does not block) and emits a structured `{ Pid; Url; Log; DataDir; Version }` handle **only after** `/api/health` answers `200` and the `dataDir` matches the canonical `-DataDir` (the host's `Acquire`-before-bind lockfile guarantees that listener is the sole legitimate instance for the store — no process-ancestry check). The idempotent reattach path emits the same five-field handle (Version from `/api/health`) plus the staleness warning.
- The launched server **survives** the tool call returning (detached via WMI, outside the harness job object).
- The detached log contains real server output — the WMI command line carries **no** redirection operators; the wrapper owns redirection (cause 3, smoke test 2) — and is **appended** per launch with a banner (crash-loop evidence preserved).
- `-SkipBuild` skips the foreground build; the default path runs `run.ps1 -BuildOnly` (frontend **and** `dotnet build`) in the **foreground** and aborts there on failure, before any detach.
- `run.ps1` gains `-BuildOnly` and `-SkipBuild` (mutually exclusive); the no-switch default is behavior-equivalent (the added explicit `dotnet build` is a no-op on output); `-Reset` runs at most once, never on the detached wrapper call.
- `-Stop -DataDir <d>` tree-kills the launched process **only after a PID-name identity check** (recycle guard), and removes the pidfile, idempotently.
- An occupied `-Port` **fails by default** with a message distinguishing our-own-server (idempotent **loud** success), a different store, and an unknown occupant; `-Force` kills (name surfaced) and proceeds.
- The canonical dataDir is threaded through `run.ps1`, the health match, the pidfile, and (transitively) the lock path, so an idempotent reattach is recognized regardless of path-string form and two backends can never write one store.
- `-Stop` distinguishes a recorded-and-alive process from a recycled PID (name guard); `-Force` re-reads the occupant immediately before killing (no stale-PID `taskkill`).
- `-Port` / `-DataDir` honor the `5200 + N` band; pidfile/log/wrapper are namespaced under `-DataDir`; two agents (distinct stores) run concurrently without collision; two launches on one store stay single-instance via the host's `LockfileManager`, with stale-pidfile recovery cleaning up the loser.
- The script is Windows/pwsh-7/WMI guarded and fails fast elsewhere.
- `parallel-agent-testing.md` § "Launch the app" is rewritten to make `serve-detached.ps1` the canonical agent command; `development-process.md` is updated; `serve-detached.log` is added to `-Reset Token` cleanup.

## 11. Disposition log

Findings from the two `ce-doc-review` passes (per `CLAUDE.md` auto-review rule), recorded with disposition + one-line reason. (Round 2 appended after the second pass.)

### Round 1 (2026-06-07)

**Feasibility**
- *Get-NetTCPConnection dual-row for localhost* (P3) — **Applied** (§ 4.5: `Select-Object -Unique | -First 1`).
- *DataDir identity must normalize both sides; host echoes verbatim* (P2) — **Applied** (§ 4.6 canonicalization rule; thread one canonical string everywhere).
- *`-BuildOnly` reset interaction / double-reset risk* (P3) — **Applied** (§ 4.1 + § 2: reset never forwarded; if ever, BuildOnly-only).

**Adversarial**
- *DataDir 8.3/casing false-timeout* (P1) — **Applied** (§ 4.6, same fix as feasibility).
- *"LockfileManager catches it anyway" premise false on path-form drift → two backends* (P1) — **Applied** (§ 4.6: lock + health key on identical canonical bytes; explained explicitly).
- *Empty "log tail" in the cause-3 failure mode* (P1) — **Applied** (§ 4.2 step 8 + § 6: empty-vs-populated log diagnostic).
- *Per-launch truncation destroys crash-loop evidence* (P2) — **Applied** (§ 4.3: append + banner + size cap, replacing truncate).
- *ServerPid resolved from port-holder, not provably ours* (P2) — **Applied** (§ 4.5/§4.6: tree-ancestry check before recording; FAIL if foreign).
- *`-SkipBuild` still triggers .NET build inside wrapper* (P3) — **Applied** (§ 4.1: `-BuildOnly` now runs `dotnet build`; asymmetry documented).
- *Same-store double-fire races pidfile/wrapper* (P3) — **Applied** (§ 4.7 launch lock).
- *`--no-browser` argv survival through the splat* (P3) — **Applied** (§ 4.3 note + smoke test 16).

**Security-lens**
- *PID recycling not guarded before `taskkill`* (P1) — **Applied** (§ 4.5 PID-name guard, citing #107; smoke test 11b).
- *`serve-detached.log` captures unscrubbed raw stdout* (P2) — **Applied** (§ 4.3 sensitivity note; added to `-Reset Token` cleanup).
- *TOCTOU wrapper substitution between write and spawn* (P2) — **Skipped** (out of threat model: a same-user attacker already has code-exec and can edit `run.ps1`/postinstall; wrapper substitution adds nothing. Documented as a § 2 threat-model note rather than hardened).
- *`-ExecutionPolicy Bypass` justification + AppLocker/WDAC note* (P3) — **Applied** (§ 4.4).
- */api/health leaks dataDir path; SessionTokenMiddleware comment stale* (P3) — **Deferred** (the comment is pre-existing code, not this doc; the doc already states health returns `dataDir`. Implementation-phase note: fix the stale `// port + version` comment).

**Product-lens**
- *Two overlapping launch paths; "pointer" = two instructions* (P2) — **Applied** (§ 1 one-rule + § 7: rewrite, not append, the canonical command).
- *Idempotent success serves stale binary; version is a passive tell* (P2) — **Applied** (§ 5 loud reattach warning; § 4.6 reframes `version` as informational, not the staleness guard).
- *Pinned-port entrenches the deferred-worse auto-port* (P3) — **Applied** (§ 2 path-dependency note).
- *Two new run.ps1 switches add maintenance surface; weigh even-handedly* (P3) — **Applied** (§ 8 reframed even-handed with the maintenance tradeoff; § 4.1 specifies `-Reset` interaction).

**Scope-guardian**
- *Remove `-Force` (no current consumer)* (P1) — **Skipped** (the owner explicitly requested `-Force` in the task brief; § 5 tightened to name the precise residual scenario it serves — foreign/different-store occupant — that idempotent + `-Stop` cannot cover. Held ground per receiving-code-review: explicit user requirement overrides).
- *`-TimeoutSec` is a knob with no consumer → internal constant* (P2) — **Skipped** (kept exposed: cold-start time genuinely varies; a too-short hardcoded timeout is itself the wasted-turn failure this script prevents, and an agent that times out should be able to retry with more budget. § 3 rationale added).
- *Drop `Version` from handle* (P2) — **Partially applied** (kept in the handle since `/api/health` returns it free and it aids debugging, but dropped its role as the staleness mechanism — resolves the contradiction with product-lens).
- *Idempotent branch justified; add to § 10* (P3) — **Applied** (§ 10 acceptance criterion added).
- *Close `-Reset` forwarding as "do not add"* (P2) — **Applied** (§ 2 out-of-scope, decided).
- *Reframe § 8 build-decision; drop "main thing to confirm" hedge* (P2) — **Partially applied** (§ 8 now presents it as recommended-with-rationale and even-handed maintenance tradeoff; a light gate confirmation remains because it does touch the destructive-capable `run.ps1`).
- *Add smoke test for re-parented `-Stop` ServerPid fallback* (P2) — **Applied** (smoke test 14).

**Coherence**
- *§ 2 "-SkipBuild within launch" wording vs standalone switch* (P3) — **Applied** (§ 2 reworded: "two modes … plus a launch-mode-only `-SkipBuild`").
- *Normalization algorithm unspecified* (residual) — **Applied** (subsumed by § 4.6).

### Round 2 (2026-06-07)

Round 2 ran the same six personas with a decision primer (round-1 dispositions). **Feasibility returned zero findings** — it verified every round-1 fix against the live codebase *and a real Windows 11 environment* (confirmed `(Get-Item).FullName` expands 8.3 short names + normalizes casing on an existing dir; confirmed `dotnet run` defaults to Debug so the new `dotnet build --configuration Debug` introduces no config drift; confirmed `Program.cs:177` `Acquire`-before-bind). Product-lens and security-lens were not re-dispatched in round 2 (their round-1 findings were all dispositioned and the round-2 surface was the newly-added mechanisms, which fall to feasibility/adversarial/coherence/scope). The new findings drove a net **simplification**:

**Adversarial**
- *Orphaned launch lock has no stale-recovery → permanent "launch in progress" wedge* (P1) — **Applied (by removal).** The launcher runs foreground-in-harness (the reap-prone model of cause 2), so a `finally`-released `CreateNew` lock can orphan and wedge the store forever. Cutting the lock entirely (vs. adding PID+age recovery) eliminates the failure mode; the double-fire race it guarded is already covered by `Acquire`-before-bind + stale-pidfile recovery (§ 4.7). Converges with scope-guardian's independent "cut the lock" finding.
- *Tree-ancestry READY gate false-rejects a re-parented healthy server* (P1) — **Applied (by removal).** `ParentProcessId` survives a parent's exit stale on Windows, so the upward walk from `ServerPid` can miss `WrapperPid` and hard-FAIL a server *we* started — the exact wasted turn. Dropped the ancestry gate; identity is now `health 200 + canonical-dataDir`, backed by the `Acquire`-before-bind single-instance invariant (§ 4.2 "Why no process-ancestry gate", § 4.5, § 4.6).
- *`-Force` cites a name guard with no recorded name + TOCTOU recycle race* (P1) — **Applied.** The foreign occupant has no name we recorded; specified a re-read-OwningProcess-and-name-immediately-before-`taskkill` window instead, with skip/re-probe if the port freed or a new occupant appeared (§ 4.5, § 5 table, smoke test 17).
- *Loud idempotent warning relies on agent reading it* — **Acknowledged (residual).** Known, accepted product tradeoff from round 1; the script cannot enforce agent behavior.
- *Canonical compare vs junctions/substs* — **Suppressed by the reviewer itself** (health echoes the string verbatim, so the compare is canonical-vs-canonical by construction; attack premise unfounded).

**Coherence**
- *Step 4 "emit the existing handle" is ambiguous (pidfile lacks `version`) vs step 9 / acceptance criteria* (P75) — **Applied.** § 4.2 step 3 (idempotent) now says emit a fresh `{ Pid; Url; Log; DataDir; Version }` from `/api/health` plus the warning; § 10 made explicit.
- *Round-2 disposition log incomplete* — **Applied** (this section).

**Scope-guardian**
- *Cut the launch lock; `Acquire`-before-bind + stale-pidfile recovery already cover the race* (P75) — **Applied** (same removal as adversarial-1; smoke test 15 reframed to "stays single-instance", not "serializes").
- *§ 8 six-alternative list slightly padded* (P50) — **Skipped.** Advisory; the rationale thread (why each mechanism was chosen) has more value than the few saved lines. The per-launch-nonce and `dotnet exec` entries justify live decisions.
- *Smoke checklist proportionate; test 15 coupled to the lock* (P75) — **Applied** (test 15 reframed away from the removed lock; count stays bounded; each test ties to a correctness property).
- *ACL-denied empty log misdiagnosed as launch-shell error* (residual, low) — **Applied (wording).** The empty-log diagnostic now reads "a launch-shell / execution-policy / unwritable-log error" (§ 4.2 step 8, § 6).

**Net effect of round 2:** removed the launch lock and the process-ancestry gate (two mechanisms, one failure mode each), tightened `-Force` teardown, and fixed one handle-shape ambiguity — the spec got smaller and more correct. No finding required adding new surface.
```
