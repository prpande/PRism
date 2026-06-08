# Agent-friendly detached launcher (`scripts/serve-detached.ps1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a coding agent one command — `scripts/serve-detached.ps1 -Port <p> -DataDir <d>` — that brings the PRism dev server up as a long-lived detached process on Windows and returns a structured `{ Pid; Url; Log; DataDir; Version }` handle only once `/api/health` answers.

**Architecture:** A new `scripts/serve-detached.ps1` builds on `run.ps1` (it does not replace it). It delegates build and launch to `run.ps1` via two new additive switches (`-BuildOnly` / `-SkipBuild`), detaches through `Invoke-CimMethod Win32_Process Create` running a runtime-authored wrapper that owns its own `*>> $log` redirection, then HTTP-health-gates against `/api/health` with a canonical-dataDir match (backed by the host's `LockfileManager.Acquire`-before-bind single-instance invariant). Source of truth is [`docs/specs/2026-06-07-agent-detached-launcher-design.md`](../specs/2026-06-07-agent-detached-launcher-design.md); read it first.

**Tech Stack:** PowerShell 7 (pwsh), WMI (`Win32_Process.Create`), `Get-NetTCPConnection` / `taskkill`, ASP.NET Core `/api/health`. Windows-only by design (§2 of the spec).

---

## Testing approach (read before Task 1)

The spec (§9) deliberately adds **no** PowerShell test framework — Pester would be a heavier dependency than the ~250-line script it tests, and the C#/HTTP behaviors the script drives are already covered by the backend + Playwright suites. **Do not add Pester.** Verification is:

1. **Static checks** per task — the script parses (`pwsh -NoProfile -Command "$null = [scriptblock]::Create((Get-Content -Raw <file>))"`) and, where applicable, the new function is **dot-sourced and exercised in isolation** against fakes (no real server). This is how the destructive guards (`-Stop` recycle guard, `-Force` kill) get verified without risking a live process — per the prior burn recorded in memory ("test destructive guards in isolation, not via the whole script").
2. **The §9 manual smoke checklist**, run once at the end (Task 14) and re-run if the script changes.

**Plan-time refinements of the spec — confirm at the plan gate (both small, both flagged here so they are not silent):**

- **Dot-source testability seam.** The script guards its main body with `if ($MyInvocation.InvocationName -ne '.')` so `. ./scripts/serve-detached.ps1` defines the functions **without** running a launch. The spec does not mention this; it is added solely to let Tasks 5/6/9/11 verify the recycle guard, canonicalization, and diagnostics in isolation against fakes (the memory-recorded safety lesson). It is inert in normal use.
- **`dotnet build` target.** The spec §4.1 writes `dotnet build --configuration Debug`. From the repo root (which contains `PRism.sln`) that builds the whole solution including test projects. This plan uses **`dotnet build PRism.Web --configuration Debug`** instead — the minimal build matching exactly what `dotnet run --project PRism.Web` compiles (Web + its project refs), so it is faster and surfaces every C#/restore error **on the launch path**. Faithful to the spec's *intent* (surface compile failures synchronously), refined on the *target*. **Explicit boundary** (per scope-guardian review): a compile/restore error in a project `PRism.Web` does *not* reference — e.g. a test project — is **not** caught here; it surfaces in CI / `dotnet test`, not before detach. That is the right boundary for a launcher (you don't need test projects to run the app), but it is narrower than the spec's literal text. If you'd rather honor the spec's solution-wide build at the gate, change Task 1 Step 3's `dotnet build PRism.Web` to `dotnet build` (whole solution).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `run.ps1` | Build + (optional reset) + foreground launch. Gains two additive, behavior-preserving switches that split its build and launch phases. Single source of truth for the build commands + launch line. | **Modify** (Task 1; +`serve-detached.log` cleanup Task 13) |
| `scripts/serve-detached.ps1` | The detached launcher: platform guard, canonical-dataDir resolution, port pre-check, foreground build delegation, wrapper authoring, WMI detach, pidfile bookkeeping, health gate, `-Stop` teardown, `-Force` port reclaim. | **Create** (Tasks 2–12) |
| `<DataDir>\serve-detached.wrapper.ps1` | Runtime-authored, disposable. Owns `*>> $log` so the WMI command line carries no redirection (cause 3). Delegates to `run.ps1 -SkipBuild`. | Authored at runtime by Task 7 (not a repo file) |
| `<DataDir>\serve-detached.pid` | Per-store JSON pidfile (`wrapperPid`/`serverPid`/`port`/`url`/`dataDir`/`log`/`startedUtc`). | Authored at runtime by Task 6 (not a repo file) |
| `<DataDir>\serve-detached.log` | Raw `dotnet`/Kestrel stdout/stderr, appended per launch with a banner. Unscrubbed → added to `-Reset Token` cleanup. | Authored at runtime; cleanup wired Task 13 |
| `.ai/docs/parallel-agent-testing.md` | The `(port, dataDir)` band + launch instructions. § "Launch the app" **rewritten** so `serve-detached.ps1` is the canonical agent command. | **Modify** (Task 13) |
| `.ai/docs/development-process.md` | § "Running parallel agents" pointer updated to name `serve-detached.ps1`. | **Modify** (Task 13) |

The single `scripts/serve-detached.ps1` file holds all launcher logic as small functions plus a dot-source-guarded main. It is one cohesive responsibility (orchestrate one detached launch / teardown); splitting it across files would scatter the launch sequence the reader needs to hold at once. Functions are ordered so each task appends a self-contained, independently-checkable unit.

---

## Task 1: `run.ps1` — add `-BuildOnly` / `-SkipBuild` switches

**Files:**
- Modify: `run.ps1:32-46` (param block), `run.ps1:215-247` (build/launch block)

This is the only change to the existing launch script. It splits the unconditional build and launch phases behind two mutually-exclusive switches; the no-switch default stays behavior-equivalent.

- [ ] **Step 1: Add the two switches to the param block**

In `run.ps1`, insert the two switches **before** the `$DotnetArgs` parameter — `ValueFromRemainingArguments` must stay the **last** parameter or trailing app args bind wrong. Replace the existing `$DataDir … $DotnetArgs` tail of the `param(...)` block with:

```powershell
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'),

    # Build (frontend + backend), then return WITHOUT launching. Used by
    # scripts/serve-detached.ps1 to run the build synchronously in the foreground
    # so npm/dotnet failures surface to the caller before anything detaches.
    [switch]$BuildOnly,

    # Launch WITHOUT building (assumes a current build). Used by the detached
    # wrapper, which has already had its build done in the foreground.
    [switch]$SkipBuild,

    # MUST stay last: ValueFromRemainingArguments only binds trailing app args
    # (e.g. --no-browser) correctly when it is the final parameter.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
```

**Verified PowerShell quirk (Task-1 finding):** a bare leading `--no-browser` with no explicit `-Reset` binds *positionally* to `$Reset` and fails its `ValidateSet` — even with a `--` separator. Pass-through args only reach `$DotnetArgs` when `-Reset` is named. The detached wrapper (Task 7) therefore calls `run.ps1 -Reset None …`. No change to `$Reset` itself (keeps run.ps1's existing interface); the wrapper just names it.

- [ ] **Step 2: Add the mutual-exclusion guard**

Immediately after `$ErrorActionPreference = 'Stop'` (currently line 48), add:

```powershell
if ($BuildOnly -and $SkipBuild) {
    throw "-BuildOnly and -SkipBuild are mutually exclusive: -BuildOnly builds without launching, -SkipBuild launches without building."
}
```

The existing `-Reset` block (lines 113-213) stays exactly where it is — **before** the build/launch split — so it fires under `-BuildOnly` and `-SkipBuild` alike, unchanged.

- [ ] **Step 3: Gate the build phase behind `-SkipBuild` and add the explicit `dotnet build`**

Replace the build block (currently lines 217-226, the inner `Push-Location frontend` … `npm ci; npm run build` … `Pop-Location`) so it only runs when not `-SkipBuild`, and add an explicit backend build. The block becomes:

```powershell
Push-Location $PSScriptRoot
try {
    if (-not $SkipBuild) {
        Push-Location frontend
        try {
            # `npm ci` is deterministic (refuses to run if package.json and
            # package-lock.json drift), unlike `npm install`. Always-run also
            # avoids leaving a stale node_modules behind a lockfile change.
            #
            # Guard EACH native step explicitly. Under $ErrorActionPreference='Stop'
            # a native command's nonzero exit does NOT throw, and a later step's exit
            # code OVERWRITES $LASTEXITCODE — so a caller checking $LASTEXITCODE after
            # `run.ps1 -BuildOnly` could read 0 even though `npm ci` failed, and detach
            # against a broken build (the health-gate-timeout this script exists to
            # prevent). The per-step throw makes a mid-sequence failure abort here.
            npm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE) — resolve package-lock.json drift, or relaunch with -SkipBuild if the build is current." }
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
        } finally {
            Pop-Location
        }
        # Build the backend explicitly so C#/NuGet/restore failures on the launch
        # path surface HERE (foreground, for -BuildOnly callers) instead of inside
        # dotnet run's implicit build post-detach. Scope: PRism.Web + its project
        # refs only — exactly what `dotnet run --project PRism.Web` compiles, so it
        # is a no-op on the launch that follows. TRADEOFF (narrower than spec §4.1's
        # solution-wide `dotnet build`): a compile/restore error in a project
        # PRism.Web does NOT reference (e.g. a test project) is not caught here — it
        # surfaces in CI / `dotnet test`. The right boundary for a launcher; change
        # to `dotnet build` (whole solution) if you prefer the spec's literal scope.
        dotnet build PRism.Web --configuration Debug
        if ($LASTEXITCODE -ne 0) { throw "dotnet build PRism.Web failed (exit $LASTEXITCODE)." }
    }

    if ($BuildOnly) { return }

    # … existing env-restore + dotnet run launch block (lines 228-247) stays
    #    unchanged, still inside this try/finally …
```

Keep the existing `--no-launch-profile` / env-restore / `dotnet run` launch lines (228-247) exactly as they are, inside the same `try`, after the `if ($BuildOnly) { return }`. The closing `} finally { Pop-Location }` at the end (lines 248-250) is unchanged.

- [ ] **Step 4: Verify the script still parses**

Run:
```powershell
pwsh -NoProfile -Command "& { $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\run.ps1), [ref]$null, [ref]$null); 'parsed OK' }"
```
Expected: `parsed OK` and no parse errors.

- [ ] **Step 5: Verify `-BuildOnly` builds and returns (does not launch)**

Run (uses a throwaway store; the build writes only into the repo's `wwwroot`/`bin`):
```powershell
$d = Join-Path $env:TEMP "PRism-buildonly-$PID"
./run.ps1 -BuildOnly -Port 5210 -DataDir $d
```
Expected: `npm ci`, `npm run build`, and `dotnet build PRism.Web` all run in the foreground; the command **returns to the prompt** (does not block on a running server); nothing is listening on 5210 afterwards (`Get-NetTCPConnection -LocalPort 5210 -State Listen -ErrorAction SilentlyContinue` returns nothing).

- [ ] **Step 6: Verify the no-switch default is unchanged (smoke 12)**

Run, then Ctrl-C after the listening line:
```powershell
./run.ps1 -Port 5210 -DataDir (Join-Path $env:TEMP "PRism-default-$PID") --no-browser
```
Expected: builds then launches in the foreground exactly as before; prints `PRism listening on http://localhost:5210 (dataDir: …)`. The only visible build difference from today is the added explicit `dotnet build PRism.Web` line. Ctrl-C to stop.

- [ ] **Step 7: Commit**

```powershell
git add run.ps1
git commit -m "feat(#266): add -BuildOnly / -SkipBuild switches to run.ps1"
```

---

## Task 2: `scripts/serve-detached.ps1` skeleton — header, params, platform guard, dot-source seam

**Files:**
- Create: `scripts/serve-detached.ps1`

- [ ] **Step 1: Create the file with header, requires, and param block**

Create `scripts/serve-detached.ps1`:

```powershell
#!/usr/bin/env pwsh
#requires -Version 7
<#
.SYNOPSIS
    Launch the PRism dev server as a long-lived DETACHED process and return a
    structured handle once it is answering HTTP. The agent-facing companion to
    run.ps1 (which is foreground, for a human watching the console).

.DESCRIPTION
    Windows-only. Detaches via WMI (Win32_Process.Create) so the server survives
    the calling tool returning, runs a wrapper that owns its own log redirection,
    delegates build + launch to run.ps1, and health-gates on /api/health with a
    canonical-dataDir match before emitting { Pid; Url; Log; DataDir; Version }.

    See docs/specs/2026-06-07-agent-detached-launcher-design.md. Tracking: #266.

.EXAMPLE
    scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0
.EXAMPLE
    scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-wt-0
#>
param(
    # Same validation/default as run.ps1. Parallel agents use 5200 + N.
    [ValidateRange(1, 65535)]
    [int]$Port = 5180,

    # Same default as run.ps1. Canonicalized on entry; namespaces the pidfile/log/wrapper.
    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'),

    # Launch mode only: skip the foreground run.ps1 -BuildOnly step (build known current).
    [switch]$SkipBuild,

    # Teardown mode: read <DataDir> pidfile and tree-kill. Mutually exclusive with launch-only params.
    [switch]$Stop,

    # Launch mode only: on an occupied port NOT held by our own healthy server, kill the occupant.
    [switch]$Force,

    # Health-gate budget. Exposed (not hidden) because cold-start time varies widely.
    [ValidateRange(5, 600)]
    [int]$TimeoutSec = 90,

    # Pass-through app args (e.g. --no-browser), forwarded verbatim through run.ps1 to dotnet run.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
)

$ErrorActionPreference = 'Stop'
```

- [ ] **Step 2: Add the platform / WMI guard function**

Append:

```powershell
function Assert-Platform {
    # Windows-only by design (spec §2): the harness-reaping problem and its WMI
    # fix are Windows-specific, and Get-NetTCPConnection / taskkill / Win32_Process
    # do not exist on POSIX. Fail fast with a clear pointer rather than deep inside
    # the launch with a cryptic cmdlet-not-found.
    if (-not $IsWindows) {
        throw "serve-detached.ps1 is Windows-only (see spec §2 'Out of scope: macOS / Linux'). On POSIX, setsid/nohup already survive; use run.ps1 directly."
    }
    # A locked-down sandbox / container may lack WMI. Probe cheaply so the failure
    # is interpretable rather than surfacing as a launch-time Invoke-CimMethod error.
    try {
        $null = Get-CimClass -ClassName Win32_Process -ErrorAction Stop
    } catch {
        throw "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn outside the harness job object. Run run.ps1 in the foreground instead. Underlying error: $($_.Exception.Message)"
    }
}
```

- [ ] **Step 3: Add the dot-source-guarded main stub**

Append at the very end of the file:

```powershell
# --- main (skipped when the script is dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Assert-Platform
    # Mode dispatch + mutual-exclusion are wired in Task 12.
    throw "serve-detached.ps1 main body not yet implemented."
}
```

- [ ] **Step 4: Verify it parses and the guard works**

Run:
```powershell
pwsh -NoProfile -Command "& { $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\scripts\serve-detached.ps1), [ref]$null, [ref]$null); 'parsed OK' }"
```
Expected: `parsed OK`.

Then verify **both branches** of the dispatch condition — dot-sourcing must NOT run main, and a normal `&` invocation MUST run main:
```powershell
# Dot-source: defines functions, main suppressed (no throw):
. .\scripts\serve-detached.ps1
Get-Command Assert-Platform   # lists the function; NO "not yet implemented" throw

# Normal invocation: main runs, so the stub throw fires:
try { & .\scripts\serve-detached.ps1 -Stop -DataDir (Join-Path $env:TEMP "PRism-seam-$PID"); 'NO THROW (bad — main did not run)' }
catch { "main ran: $($_.Exception.Message)" }   # expected: the "not yet implemented" throw
```
Expected: the dot-source case lists the function with no exception; the `&` case throws "not yet implemented" — confirming the seam suppresses main only when dot-sourced, not on the real invocation path the implementation depends on.

- [ ] **Step 5: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): serve-detached skeleton — params, platform/WMI guard, dot-source seam"
```

---

## Task 3: Canonical dataDir + path computation

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Get-CanonicalDataDir`**

Insert after `Assert-Platform`:

```powershell
function Get-CanonicalDataDir {
    # Resolve -DataDir to ONE long-path absolute string and use that exact string
    # everywhere (run.ps1 --dataDir -> /api/health body, the health compare, the
    # pidfile, and transitively LockfileManager's lock path). Get-Item .FullName
    # expands 8.3 short names (%TEMP% often expands to PRATY~1\...) AND normalizes
    # casing; [IO.Path]::GetFullPath does NEITHER, which would make the health
    # compare miss a healthy server and let two launches key different lock paths
    # onto one store (spec §4.6). Create the directory first so .FullName resolves.
    param([string]$DataDir)

    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        throw "-DataDir must be a non-empty path."
    }
    $abs = [System.IO.Path]::GetFullPath($DataDir)   # collapse . / .. / separators
    if (-not (Test-Path -LiteralPath $abs -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $abs | Out-Null
    }
    # .FullName on an existing dir is the long-path, case-normalized form.
    return (Get-Item -LiteralPath $abs).FullName.TrimEnd('\', '/')
}
```

- [ ] **Step 2: Add `Get-ServeDetachedPaths`**

Append:

```powershell
function Get-ServeDetachedPaths {
    # All per-store artifacts namespaced under the canonical DataDir so parallel
    # agents (distinct stores) never collide and -Stop -DataDir <d> is unambiguous.
    param([string]$CanonicalDataDir)
    return [pscustomobject]@{
        DataDir = $CanonicalDataDir
        Pidfile = Join-Path $CanonicalDataDir 'serve-detached.pid'
        Log     = Join-Path $CanonicalDataDir 'serve-detached.log'
        Wrapper = Join-Path $CanonicalDataDir 'serve-detached.wrapper.ps1'
    }
}
```

- [ ] **Step 3: Verify canonicalization in isolation (proves the §4.6 fix)**

```powershell
. .\scripts\serve-detached.ps1
$long = Join-Path $env:TEMP "PRism-canon-$PID"
New-Item -ItemType Directory -Force $long | Out-Null
# Build an 8.3 short-name + trailing-backslash + mixed-case variant of the SAME dir:
$short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($long).ShortPath + '\'
$a = Get-CanonicalDataDir -DataDir $long
$b = Get-CanonicalDataDir -DataDir $short
"$a"; "$b"; "match = $($a -ieq $b)"
```
Expected: both `$a` and `$b` print the identical long-path form; `match = True`. This is the canonicalization guarantee the health compare and lock path depend on.

- [ ] **Step 4: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): canonical dataDir resolution + per-store path computation"
```

---

## Task 4: Health probe + port-listener helpers

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Invoke-HealthProbe`**

Append:

```powershell
function Invoke-HealthProbe {
    # GET /api/health: the only endpoint reachable from bare PowerShell (GET so
    # OriginCheckMiddleware doesn't apply; auth-exempt via IsLivenessEndpoint).
    # Returns the parsed body { port; version; dataDir } on a 200, else $null.
    # A connection-refused (nobody listening / still starting) is expected during
    # polling, not an error — swallow it and return $null.
    param([int]$Port, [int]$TimeoutSec = 2)
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" `
            -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        if ($resp.StatusCode -ne 200) { return $null }
        return ($resp.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}
```

- [ ] **Step 2: Add `Get-PortOwnerPid`**

Append:

```powershell
function Get-PortOwnerPid {
    # The app binds the 'localhost' hostname, so Kestrel listens on BOTH 127.0.0.1
    # and ::1 -> Get-NetTCPConnection returns TWO rows with the SAME OwningProcess.
    # Dedupe defensively (spec §4.5). Returns the owning PID, or $null if free.
    param([int]$Port)
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue |
        Select-Object -Unique | Select-Object -First 1
    return $owner
}
```

- [ ] **Step 3: Verify both helpers in isolation (no server up)**

```powershell
. .\scripts\serve-detached.ps1
Invoke-HealthProbe -Port 5199    # nothing there -> $null, no throw
Get-PortOwnerPid -Port 5199      # free -> $null
```
Expected: both return nothing / `$null` without error (connection-refused is swallowed). A populated-server check happens in the Task 14 smoke run.

- [ ] **Step 4: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): /api/health probe + dual-row port-owner resolution"
```

---

## Task 5: Destructive kill guards — recycle-safe stop, force-reclaim (isolation-tested)

**Files:**
- Modify: `scripts/serve-detached.ps1`

These two functions call `taskkill`. They are verified **in isolation against an unrelated live PID** (smoke 11b's logic) before ever being wired into a launch — the recorded lesson from the prior `-Reset` near-miss.

- [ ] **Step 1: Add `Stop-ProcessIfMatches` (the recycle guard)**

Append:

```powershell
function Stop-ProcessIfMatches {
    # PID-recycle guard (spec §4.5; history: #107 LockfileManager recycled-PID
    # crash). A 32-bit PID space recycles fast, so a recorded PID may now belong
    # to an unrelated process. Only tree-kill if the PID is alive AND its process
    # name still matches what we expect. Returns $true if a kill was issued.
    param(
        [int]$ProcessId,
        [string[]]$ExpectedNames,   # e.g. @('pwsh') for the wrapper, @('dotnet','PRism.Web') for the server
        [switch]$Tree               # /T to kill the whole tree (wrapper -> dotnet run -> app)
    )
    if (-not $ProcessId) { return $false }
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }                       # already gone
    if ($ExpectedNames -notcontains $p.Name) { return $false }  # recycled to a different process
    if ($Tree) { taskkill /PID $ProcessId /T /F | Out-Null }
    else       { taskkill /PID $ProcessId /F | Out-Null }
    return $true
}
```

- [ ] **Step 2: Add `Invoke-ForcePortReclaim` (the `-Force` re-read window)**

Append:

```powershell
function Invoke-ForcePortReclaim {
    # -Force occupant kill (spec §4.5/§5). The occupant is FOREIGN, so there is no
    # name we recorded to compare. Defend against the recycle TOCTOU by re-reading
    # the owner immediately before killing: surface the name, then kill THAT pid.
    # If the port freed on its own -> nothing to do. If a NEW occupant appeared ->
    # re-probe (caller loops), don't fire at a stale pid.
    param([int]$Port)
    $owner = Get-PortOwnerPid -Port $Port
    if (-not $owner) { return $true }   # already free
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    $name = if ($p) { $p.Name } else { '<exited>' }
    Write-Host "  -Force: killing port $Port occupant PID $owner ($name)" -ForegroundColor Yellow
    if (-not $p) { return $true }       # exited between read and kill -> port should be free
    taskkill /PID $owner /F | Out-Null
    return $true
}
```

- [ ] **Step 3: Verify the recycle guard does NOT kill an unrelated process (smoke 11b in isolation)**

```powershell
. .\scripts\serve-detached.ps1
$np = Start-Process notepad -PassThru
try {
    # ExpectedNames says 'pwsh' but the live PID is notepad -> must NOT kill.
    $killed = Stop-ProcessIfMatches -ProcessId $np.Id -ExpectedNames @('pwsh') -Tree
    "killed = $killed (expected False)"
    "still alive = $((Get-Process -Id $np.Id -ErrorAction SilentlyContinue) -ne $null) (expected True)"
} finally {
    Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue
}
```
Expected: `killed = False`, `still alive = True` — the name mismatch protected the unrelated process. Then verify the positive case: a real `pwsh` child IS killed when the name matches:
```powershell
. .\scripts\serve-detached.ps1
$pw = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru
$killed = Stop-ProcessIfMatches -ProcessId $pw.Id -ExpectedNames @('pwsh') -Tree
"killed = $killed (expected True)"; Start-Sleep 1
"gone = $((Get-Process -Id $pw.Id -ErrorAction SilentlyContinue) -eq $null) (expected True)"
```
Expected: `killed = True`, `gone = True`.

- [ ] **Step 4: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): recycle-safe Stop-ProcessIfMatches + -Force port reclaim"
```

---

## Task 6: Pidfile read/write + log size cap

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Write-Utf8NoBom` (mirrors run.ps1) and pidfile helpers**

Append:

```powershell
function Write-Utf8NoBom {
    # Same helper run.ps1 uses (UTF-8, no BOM), so artifacts are byte-consistent.
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Write-Pidfile {
    # Per-store JSON pidfile (spec §4.7). serverPid is filled after the health gate.
    param(
        [string]$Path, [int]$WrapperPid, [Nullable[int]]$ServerPid,
        [int]$Port, [string]$Url, [string]$DataDir, [string]$Log, [string]$StartedUtc
    )
    $obj = [ordered]@{
        wrapperPid = $WrapperPid
        serverPid  = $ServerPid
        port       = $Port
        url        = $Url
        dataDir    = $DataDir
        log        = $Log
        startedUtc = $StartedUtc
    }
    Write-Utf8NoBom -Path $Path -Text ($obj | ConvertTo-Json -Depth 5)
}

function Read-Pidfile {
    # Returns the parsed pidfile object, or $null if absent/corrupt.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
    catch { return $null }
}
```

- [ ] **Step 2: Add `Limit-LogSize`**

Append:

```powershell
function Limit-LogSize {
    # The log is APPENDED per launch (so crash-loop evidence survives a relaunch),
    # so cap it: when it exceeds the threshold, keep the tail. Bounds append growth.
    param([string]$Log, [int]$MaxBytes = 5MB, [int]$KeepLines = 2000)
    if (-not (Test-Path -LiteralPath $Log)) { return }
    if ((Get-Item -LiteralPath $Log).Length -le $MaxBytes) { return }
    $tail = Get-Content -LiteralPath $Log -Tail $KeepLines
    Write-Utf8NoBom -Path $Log -Text (($tail -join [Environment]::NewLine) + [Environment]::NewLine)
}
```

- [ ] **Step 3: Verify pidfile round-trip + log cap in isolation**

```powershell
. .\scripts\serve-detached.ps1
$d = Join-Path $env:TEMP "PRism-pid-$PID"; New-Item -ItemType Directory -Force $d | Out-Null
$pf = Join-Path $d 'serve-detached.pid'
Write-Pidfile -Path $pf -WrapperPid 111 -ServerPid 222 -Port 5200 -Url 'http://localhost:5200' -DataDir $d -Log "$d\serve-detached.log" -StartedUtc '2026-06-07T00:00:00Z'
$r = Read-Pidfile -Path $pf
"wrapperPid=$($r.wrapperPid) serverPid=$($r.serverPid) port=$($r.port)"   # 111 / 222 / 5200
Read-Pidfile -Path (Join-Path $d 'nope.pid')   # absent -> $null
```
Expected: `wrapperPid=111 serverPid=222 port=5200`; the absent read returns nothing.

- [ ] **Step 4: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): pidfile read/write + appended-log size cap"
```

---

## Task 7: Author the detached wrapper (cause-3 fix)

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Write-WrapperScript`**

Append:

```powershell
function Write-WrapperScript {
    # Write the disposable wrapper that owns its own redirection (spec §4.3). This
    # is the whole cause-3 fix: *>> $log is parsed as a redirection INSIDE this real
    # pwsh process, instead of becoming a literal arg on the WMI command line.
    # APPEND (*>>) with a per-launch banner so a relaunch never erases the prior
    # run's diagnostics (a failed launch emits no handle -> the log is the only record).
    param(
        [string]$WrapperPath, [string]$Log, [string]$RepoRoot,
        [int]$Port, [string]$DataDir, [string[]]$DotnetArgs, [string]$StartedUtc
    )
    $runPs1 = Join-Path $RepoRoot 'run.ps1'
    # Build the pass-through arg tail. --no-browser is ALWAYS injected first (a
    # detached WMI session must never open a browser); caller args follow it.
    # Strip embedded CR/LF from each element before single-quoting: a newline inside
    # an arg would split the authored call line into multiple lines (a malformed
    # wrapper that fails to parse and surfaces as an empty-log launch failure).
    # Defensive — an agent may construct DotnetArgs from untrusted text.
    $argTail = @('--no-browser') + @($DotnetArgs | Where-Object { $_ } | ForEach-Object { $_ -replace '[\r\n]+', ' ' })
    $argLiteral = ($argTail | ForEach-Object { "'$($_.Replace("'", "''"))'" }) -join ', '

    $content = @"
# serve-detached.wrapper.ps1 — AUTHORED AT RUNTIME, disposable, overwritten each launch.
# Owns its own redirection so the WMI command line carries none (spec cause 3).
`$ErrorActionPreference = 'Stop'
`$log = '$($Log.Replace("'", "''"))'
"=== serve-detached launch @ $StartedUtc port $Port ===" *>> `$log
& '$($runPs1.Replace("'", "''"))' -Reset None -SkipBuild -Port $Port -DataDir '$($DataDir.Replace("'", "''"))' $argLiteral *>> `$log
"@
    Write-Utf8NoBom -Path $WrapperPath -Text $content
}
```

- [ ] **Step 2: Verify the authored wrapper is valid PowerShell and contains the redirection (smoke 2 precondition)**

```powershell
. .\scripts\serve-detached.ps1
$d = Join-Path $env:TEMP "PRism-wrap-$PID"; New-Item -ItemType Directory -Force $d | Out-Null
$w = Join-Path $d 'serve-detached.wrapper.ps1'
Write-WrapperScript -WrapperPath $w -Log "$d\serve-detached.log" -RepoRoot (Resolve-Path .).Path -Port 5200 -DataDir $d -DotnetArgs @() -StartedUtc '2026-06-07T00:00:00Z'
# Must parse, and must contain *>> (the redirection that the wrapper, not the WMI line, owns):
$null = [System.Management.Automation.Language.Parser]::ParseFile($w, [ref]$null, [ref]$null)
Select-String -Path $w -Pattern '\*>>' -Quiet     # expected True
Select-String -Path $w -Pattern '--no-browser' -Quiet   # expected True
Get-Content $w
# Author again with tricky args (embedded space + single-quote) — must still parse:
Write-WrapperScript -WrapperPath $w -Log "$d\serve-detached.log" -RepoRoot (Resolve-Path .).Path -Port 5200 -DataDir $d -DotnetArgs @('--flag with space', "--has'quote") -StartedUtc '2026-06-07T00:00:00Z'
$null = [System.Management.Automation.Language.Parser]::ParseFile($w, [ref]$null, [ref]$null)   # must not throw
```
Expected: the file parses; `*>>` and `--no-browser` are present; the `& '<repo>\run.ps1' -Reset None -SkipBuild …` line is well-formed with single-quoted paths; the tricky-args re-author also parses (the per-element single-quote escaping + newline strip held).

- [ ] **Step 3: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): author the redirection-owning detached wrapper"
```

---

## Task 8: WMI detach

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Start-DetachedWrapper`**

Append:

```powershell
function Start-DetachedWrapper {
    # Spawn the wrapper via WMI so it lands OUTSIDE the harness job object and
    # survives the tool call returning (spec cause 2 + §4.4). CRITICAL: the
    # CommandLine carries NO redirection operators — the wrapper owns those.
    # -ExecutionPolicy Bypass: the wrapper is an unsigned ephemeral file.
    # Returns the wrapper PID. Note ReturnValue==0 only means the OS CREATED the
    # process — it does NOT prove the wrapper ran or wrote (see the gate diagnostics).
    param([string]$WrapperPath, [string]$RepoRoot)
    $cmd = "pwsh -NoProfile -ExecutionPolicy Bypass -File `"$WrapperPath`""
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmd; CurrentDirectory = $RepoRoot }
    if ($res.ReturnValue -ne 0) {
        throw "WMI Win32_Process.Create refused to spawn the wrapper (ReturnValue=$($res.ReturnValue)). The server was not launched."
    }
    return [int]$res.ProcessId
}
```

- [ ] **Step 2: Verify a benign WMI spawn returns a live PID (mechanism check, no server)**

```powershell
. .\scripts\serve-detached.ps1
$d = Join-Path $env:TEMP "PRism-wmi-$PID"; New-Item -ItemType Directory -Force $d | Out-Null
$w = Join-Path $d 'noop.wrapper.ps1'
Write-Utf8NoBom -Path $w -Text "'hi' *>> '$d\noop.log'`nStart-Sleep 3"
$pid2 = Start-DetachedWrapper -WrapperPath $w -RepoRoot (Resolve-Path .).Path
"spawned pid = $pid2"
Start-Sleep 1
"alive = $((Get-Process -Id $pid2 -ErrorAction SilentlyContinue) -ne $null) (expected True)"
"log wrote = $((Test-Path "$d\noop.log") -and (Get-Content "$d\noop.log")) (expected hi)"
```
Expected: a numeric PID, `alive = True`, and the noop log contains `hi` — confirming WMI spawn + wrapper-owned redirection both work end to end.

- [ ] **Step 3: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): WMI Win32_Process.Create detach"
```

---

## Task 9: Health gate + readiness diagnostics

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Wait-ForHealth`**

Append:

```powershell
function Wait-ForHealth {
    # Poll /api/health until 200 AND body.dataDir matches the canonical store, or
    # the wrapper dies, or -TimeoutSec elapses (spec §4.2 step 8 + §4.6). On READY,
    # returns { ServerPid; Version } from the SAME probe that proved readiness (so
    # the caller needs no second /api/health round trip). On failure, throws a message
    # that distinguishes an EMPTY log (wrapper never wrote — launch-shell /
    # execution-policy / unwritable-log error) from a POPULATED log (server started
    # but exited — tail printed). No process-ancestry check: Acquire-before-bind
    # guarantees any listener for this store is the sole legitimate instance.
    param(
        [int]$Port, [string]$CanonicalDataDir, [int]$TimeoutSec,
        [int]$WrapperPid, [string]$Log
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $body = Invoke-HealthProbe -Port $Port
        if ($null -ne $body -and ($body.dataDir.TrimEnd('\', '/') -ieq $CanonicalDataDir)) {
            # Carry $body.version out from the SAME probe that proved READY — avoids a
            # redundant second probe (and the null-version race if the port flickers).
            return [pscustomobject]@{ ServerPid = (Get-PortOwnerPid -Port $Port); Version = $body.version }    # READY
        }
        # Fail fast if the wrapper died before the server ever answered.
        if (-not (Get-Process -Id $WrapperPid -ErrorAction SilentlyContinue)) {
            throw (Get-LaunchFailureMessage -Log $Log -WrapperPid $WrapperPid -Reason 'died')
        }
        Start-Sleep -Milliseconds 500
    }
    throw (Get-LaunchFailureMessage -Log $Log -WrapperPid $WrapperPid -Reason 'timeout' -Port $Port)
}

function Get-LaunchFailureMessage {
    # Empty-vs-populated log diagnostic (spec §4.2 step 8, §6). An empty/absent log
    # means the wrapper never ran (launch-shell / execution-policy / unwritable-log);
    # a populated log means the server started then exited (print the tail).
    param([string]$Log, [int]$WrapperPid, [string]$Reason, [int]$Port = 0)
    $hasLog = (Test-Path -LiteralPath $Log) -and ((Get-Item -LiteralPath $Log).Length -gt 0)
    $head = if ($Reason -eq 'timeout') {
        "Health gate timed out waiting for http://localhost:$Port/api/health. The port may have been taken by another process after the pre-check."
    } else {
        "The launched wrapper (PID $WrapperPid) exited before the server answered."
    }
    if (-not $hasLog) {
        return "$head`nThe log at '$Log' is EMPTY — the wrapper never wrote, which points to a launch-shell / execution-policy / unwritable-log error rather than a server crash."
    }
    $tail = (Get-Content -LiteralPath $Log -Tail 30) -join [Environment]::NewLine
    return "$head`nLog tail ($Log):`n$tail"
}
```

- [ ] **Step 2: Verify the diagnostic picks the right branch in isolation (smoke 10/10b logic)**

```powershell
. .\scripts\serve-detached.ps1
$d = Join-Path $env:TEMP "PRism-diag-$PID"; New-Item -ItemType Directory -Force $d | Out-Null
$log = Join-Path $d 'serve-detached.log'
# Empty-log branch:
"" | Set-Content $log
(Get-LaunchFailureMessage -Log $log -WrapperPid 999 -Reason 'died') -match 'EMPTY'   # expected True
# Populated-log branch:
"Kestrel boom`nUnhandled exception" | Set-Content $log
(Get-LaunchFailureMessage -Log $log -WrapperPid 999 -Reason 'died') -match 'Log tail'  # expected True
```
Expected: first match `True` (empty → "wrapper never wrote"), second `True` (populated → tail printed). The live READY path is covered by Task 14 smoke 1.

- [ ] **Step 3: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): health gate + empty-vs-populated launch failure diagnostics"
```

---

## Task 10: `Invoke-Launch` — the launch orchestration

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Invoke-Launch`**

Append. This wires Tasks 3–9 into the §4.2 launch flow:

```powershell
function Invoke-Launch {
    param(
        [int]$Port, [string]$RawDataDir, [switch]$SkipBuild, [switch]$Force,
        [int]$TimeoutSec, [string[]]$DotnetArgs
    )
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $canonical = Get-CanonicalDataDir -DataDir $RawDataDir
    $paths = Get-ServeDetachedPaths -CanonicalDataDir $canonical
    $url = "http://localhost:$Port"
    $startedUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    # --- Step 3: port pre-check (spec §5) ---
    $ownerPid = Get-PortOwnerPid -Port $Port
    if ($ownerPid) {
        $body = Invoke-HealthProbe -Port $Port
        $isPrism = $null -ne $body -and $null -ne $body.dataDir
        $sameStore = $isPrism -and ($body.dataDir.TrimEnd('\', '/') -ieq $canonical)
        if ($sameStore) {
            # Idempotent reattach — LOUD (spec §5). No kill, no rebuild.
            Write-Host "Reattached to a server already running for this store; no rebuild occurred — it may predate your working tree. Run 'serve-detached.ps1 -Stop -DataDir `"$canonical`"' then relaunch to refresh." -ForegroundColor Yellow
            Write-Pidfile -Path $paths.Pidfile -WrapperPid 0 -ServerPid $ownerPid -Port $Port -Url $url -DataDir $canonical -Log $paths.Log -StartedUtc $startedUtc
            return [pscustomobject]@{ Pid = $ownerPid; Url = $url; Log = $paths.Log; DataDir = $canonical; Version = $body.version }
        }
        if (-not $Force) {
            if ($isPrism) {
                throw "Port $Port is serving a DIFFERENT PRism store ('$($body.dataDir)'); pick another port (5200 + N) or pass -Force to kill it."
            }
            $occ = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            throw "Port $Port is held by PID $ownerPid ('$($occ.Name)', not a PRism health endpoint); free it or pass -Force."
        }
        # -Force: reclaim the port (re-read-before-kill window, §4.5).
        Invoke-ForcePortReclaim -Port $Port | Out-Null
        Start-Sleep -Milliseconds 300
        if (Get-PortOwnerPid -Port $Port) { throw "Port $Port still occupied after -Force; aborting." }
    }

    # --- Step 4: foreground build (unless -SkipBuild) ---
    if (-not $SkipBuild) {
        & (Join-Path $repoRoot 'run.ps1') -Reset None -BuildOnly -Port $Port -DataDir $canonical
        if ($LASTEXITCODE -ne 0) {
            throw "Foreground build (run.ps1 -BuildOnly) failed with exit code $LASTEXITCODE — fix the npm/dotnet error above (or pass -SkipBuild if the build is known current). Nothing was detached."
        }
    }

    # --- Steps 5-7: author wrapper, detach, write pidfile ---
    Limit-LogSize -Log $paths.Log
    Write-WrapperScript -WrapperPath $paths.Wrapper -Log $paths.Log -RepoRoot $repoRoot -Port $Port -DataDir $canonical -DotnetArgs $DotnetArgs -StartedUtc $startedUtc
    $wrapperPid = Start-DetachedWrapper -WrapperPath $paths.Wrapper -RepoRoot $repoRoot
    Write-Pidfile -Path $paths.Pidfile -WrapperPid $wrapperPid -ServerPid $null -Port $Port -Url $url -DataDir $canonical -Log $paths.Log -StartedUtc $startedUtc

    # --- Step 8: health gate ---
    $ready = Wait-ForHealth -Port $Port -CanonicalDataDir $canonical -TimeoutSec $TimeoutSec -WrapperPid $wrapperPid -Log $paths.Log
    $serverPid = $ready.ServerPid
    $version = $ready.Version    # from the same probe that proved READY — no second round trip
    Write-Pidfile -Path $paths.Pidfile -WrapperPid $wrapperPid -ServerPid $serverPid -Port $Port -Url $url -DataDir $canonical -Log $paths.Log -StartedUtc $startedUtc
    return [pscustomobject]@{ Pid = $serverPid; Url = $url; Log = $paths.Log; DataDir = $canonical; Version = $version }
}
```

- [ ] **Step 2: Verify it parses**

```powershell
pwsh -NoProfile -Command "& { $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\scripts\serve-detached.ps1), [ref]$null, [ref]$null); 'parsed OK' }"
```
Expected: `parsed OK`. (End-to-end behavior is verified in Task 14; this task only assembles the flow.)

- [ ] **Step 3: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): Invoke-Launch — port pre-check, build, detach, health gate, handle"
```

---

## Task 11: `Invoke-Stop` — teardown

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Add `Invoke-Stop`**

Append:

```powershell
function Invoke-Stop {
    # Teardown (spec §4.5). Read the per-store pidfile, tree-kill the wrapper root
    # behind the recycle guard, fall back to ServerPid if the wrapper is already
    # gone but the app still listens (re-parented case), remove the pidfile.
    # Idempotent: a missing/stale pidfile reports "not running" and exits 0.
    param([string]$RawDataDir)
    $canonical = Get-CanonicalDataDir -DataDir $RawDataDir
    $paths = Get-ServeDetachedPaths -CanonicalDataDir $canonical
    $pf = Read-Pidfile -Path $paths.Pidfile
    if ($null -eq $pf) {
        Write-Host "No pidfile at '$($paths.Pidfile)' — nothing to stop." -ForegroundColor DarkGray
        return
    }

    $killed = $false
    if ($pf.wrapperPid) {
        $killed = Stop-ProcessIfMatches -ProcessId ([int]$pf.wrapperPid) -ExpectedNames @('pwsh') -Tree
    }
    if (-not $killed -and $pf.serverPid) {
        # Re-parented: wrapper gone, app still listening. Kill the server directly.
        $killed = Stop-ProcessIfMatches -ProcessId ([int]$pf.serverPid) -ExpectedNames @('dotnet', 'PRism.Web') -Tree
    }

    Remove-Item -LiteralPath $paths.Pidfile -Force -ErrorAction SilentlyContinue
    if ($killed) { Write-Host "Stopped PRism server for store '$canonical'." -ForegroundColor Green }
    else         { Write-Host "Server for store '$canonical' was not running (stale pidfile cleaned up)." -ForegroundColor DarkGray }
}
```

- [ ] **Step 2: Verify stale/absent pidfile is idempotent (no throw)**

```powershell
. .\scripts\serve-detached.ps1
$d = Join-Path $env:TEMP "PRism-stop-$PID"; New-Item -ItemType Directory -Force $d | Out-Null
Invoke-Stop -RawDataDir $d   # no pidfile -> "nothing to stop", exit 0, no throw
# Stale pidfile (dead PIDs):
Write-Pidfile -Path (Join-Path $d 'serve-detached.pid') -WrapperPid 999999 -ServerPid 999998 -Port 5200 -Url 'http://localhost:5200' -DataDir $d -Log "$d\serve-detached.log" -StartedUtc '2026-06-07T00:00:00Z'
Invoke-Stop -RawDataDir $d   # dead PIDs -> "not running", pidfile removed
"pidfile gone = $(-not (Test-Path (Join-Path $d 'serve-detached.pid'))) (expected True)"
```
Expected: both calls complete without error; the second reports "not running" and removes the pidfile.

- [ ] **Step 3: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): Invoke-Stop teardown with recycle guard + ServerPid fallback"
```

---

## Task 12: Main dispatch + mode mutual-exclusion

**Files:**
- Modify: `scripts/serve-detached.ps1`

- [ ] **Step 1: Replace the main stub with real dispatch**

Replace the Task 2 main stub (`if ($MyInvocation.InvocationName -ne '.') { Assert-Platform; … throw "…not yet implemented." }`) with:

```powershell
# --- main (skipped when the script is dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Assert-Platform

    if ($Stop) {
        # -Stop is teardown only: launch-mode params are meaningless with it.
        if ($SkipBuild -or $Force -or ($DotnetArgs -and $DotnetArgs.Count -gt 0)) {
            throw "-Stop is teardown mode and cannot be combined with -SkipBuild / -Force / pass-through args."
        }
        Invoke-Stop -RawDataDir $DataDir
    }
    else {
        $handle = Invoke-Launch -Port $Port -RawDataDir $DataDir -SkipBuild:$SkipBuild -Force:$Force -TimeoutSec $TimeoutSec -DotnetArgs $DotnetArgs
        $handle | Format-List | Out-String | Write-Host
        $handle   # emit the object so a caller can capture { Pid; Url; Log; DataDir; Version }
    }
}
```

- [ ] **Step 2: Verify mode mutual-exclusion rejects bad combinations**

```powershell
try { .\scripts\serve-detached.ps1 -Stop -Force -DataDir (Join-Path $env:TEMP "PRism-x-$PID"); 'NO THROW (bad)' }
catch { "rejected: $($_.Exception.Message)" }
```
Expected: `rejected: -Stop is teardown mode and cannot be combined with …`.

- [ ] **Step 3: Verify `-Stop` on an empty store is clean end-to-end**

```powershell
.\scripts\serve-detached.ps1 -Stop -DataDir (Join-Path $env:TEMP "PRism-x-$PID")
```
Expected: prints "nothing to stop", exit 0.

- [ ] **Step 4: Commit**

```powershell
git add scripts/serve-detached.ps1
git commit -m "feat(#266): main dispatch + -Stop mode mutual-exclusion"
```

---

## Task 13: Doc updates + `-Reset Token` log cleanup

**Files:**
- Modify: `.ai/docs/parallel-agent-testing.md` (§ "Launch the app")
- Modify: `.ai/docs/development-process.md` (§ "Running parallel agents")
- Modify: `run.ps1` (`Remove-TokenCacheFiles`)

> **Locate edits by content, not line number.** Task 1 already shifted `run.ps1`'s line numbers, and `parallel-agent-testing.md` has been touched by recent PRs (#217/#228). Find each edit site by its section heading / function name / a unique nearby string — the line numbers below are orientation only and may be stale.

- [ ] **Step 1: Rewrite `parallel-agent-testing.md` § "Launch the app"**

Replace the entire `## Launch the app` section (find the `## Launch the app` heading; it currently spans from that heading to just before `## Run the frontend Playwright suite`) with a `serve-detached.ps1`-primary version that demotes foreground `run.ps1` to the human-watching case:

````markdown
## Launch the app

**Agents launch with `serve-detached.ps1`** — it brings the server up *detached*
(survives the tool call returning), waits until `/api/health` actually answers,
and prints a structured handle. A human who wants to watch the console runs
`run.ps1` in the foreground instead.

```powershell
# From your worktree root (agent / non-interactive):
scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0
```

- The call **returns** once the server answers, emitting
  `{ Pid; Url; Log; DataDir; Version }`. `Url` is `http://localhost:5200`; the
  server keeps running after the call returns.
- Build is synchronous and in the foreground, so an `npm ci` lockfile-drift or a
  C# compile error fails the call *before* anything detaches (you see the real
  error, not a timeout). Pass `-SkipBuild` only when the build is known current.
- Relaunching the same store while it is healthy is idempotent — it reattaches
  and **warns** that no rebuild occurred (the running server may predate your
  edits; `-Stop` then relaunch to refresh).
- Tear down with `scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-wt-0`.
- An occupied port **fails by default** (it is most likely another agent's
  server); pass `-Force` to kill a foreign occupant and take the port.

```powershell
# Human, watching the console (foreground, blocks until Ctrl-C):
./run.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 --no-browser
```

- `run.ps1` passes `--no-launch-profile` (so `-Port` is honored over
  `launchSettings.json`'s 5180) and restores `ASPNETCORE_ENVIRONMENT=Development`
  (so the SPA bundle serves — Production via `dotnet run` would serve an empty
  bundle). It prints `PRism listening on http://localhost:5200 (dataDir: …)`.
- Two instances with distinct `(port, dataDir)` run concurrently with no lockfile
  contention. Defaults are unchanged: bare `./run.ps1 --no-browser` is still
  `5180` + `%LocalApplicationData%\PRism` + Development.
````

- [ ] **Step 2: Update `development-process.md` § "Running parallel agents"**

In the paragraph under the `## Running parallel agents (testing without collisions)` heading, change the launch sentence so it names `serve-detached.ps1` as the agent command. Replace:

> `private `(port, dataDir)`: launch with `./run.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 --no-browser`, and run the frontend e2e with`

with:

> `private `(port, dataDir)`: agents launch detached with `scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0` (a human watching the console uses `./run.ps1` in the foreground), and run the frontend e2e with`

- [ ] **Step 3: Add `serve-detached.log` to `-Reset Token` cleanup in `run.ps1`**

In `Remove-TokenCacheFiles` (search for the `Remove-Item` line that deletes the `$previousPath` / `.previous` file), after that line and before the function's closing brace, also remove the detached log (raw, unscrubbed stdout — spec §4.3 sensitivity). Add:

```powershell
    $serveLog = Join-Path $DataDir 'serve-detached.log'
    Write-Host "  removing $serveLog" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $serveLog -Force -ErrorAction SilentlyContinue
```

- [ ] **Step 4: Verify docs render and run.ps1 still parses**

```powershell
pwsh -NoProfile -Command "& { $null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\run.ps1), [ref]$null, [ref]$null); 'run.ps1 parsed OK' }"
```
Expected: `run.ps1 parsed OK`. Eyeball the two markdown sections for correct fences/links.

- [ ] **Step 5: Run prettier on the changed docs (CI gate — bypass rtk per memory)**

```powershell
node ./node_modules/prettier/bin/prettier.cjs --check ".ai/docs/parallel-agent-testing.md" ".ai/docs/development-process.md"
```
Expected: both pass (or run `--write` then re-check). The memory note warns rtk can mask prettier output — invoke prettier directly.

- [ ] **Step 6: Commit**

```powershell
git add .ai/docs/parallel-agent-testing.md .ai/docs/development-process.md run.ps1
git commit -m "docs(#266): make serve-detached.ps1 the canonical agent launch command + cleanup log"
```

---

## Task 14: Full manual smoke run (§9 checklist)

**Files:** none (verification only)

Run the spec §9 checklist end to end on Windows, against a throwaway `%TEMP%` store. Record pass/fail for each in the PR's `## Proof` section. Do **not** use the real `%LocalApplicationData%\PRism` store.

- [ ] **Step 1: Cold launch → ready handle (smoke 1)**

```powershell
$d = "$env:TEMP\PRism-st"
$h = .\scripts\serve-detached.ps1 -Port 5200 -DataDir $d --no-browser
$h    # { Pid; Url=http://localhost:5200; Log; DataDir; Version }
(Invoke-WebRequest http://localhost:5200/api/health -UseBasicParsing).Content   # 200, dataDir matches
Get-Process -Id $h.Pid   # still alive AFTER the call returned (survived the harness)
```
Expected: the call returns (no hang); handle printed; `/api/health` 200 with matching `dataDir`; process alive.

- [ ] **Step 2: Redirection works — log non-empty (smoke 2)**

```powershell
Get-Content "$env:TEMP\PRism-st\serve-detached.log" -Tail 20
```
Expected: real `dotnet`/Kestrel output (the `=== launch ===` banner + listening line), **not** a `pwsh` "unexpected token '*>>'" error. Regression guard for cause 3.

- [ ] **Step 3: Idempotent relaunch is LOUD (smoke 7) + denormalized path (smoke 7b)**

```powershell
.\scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-st --no-browser   # warns "no rebuild occurred", returns handle, no rebuild, no Lockfile error
$short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder("$env:TEMP\PRism-st").ShortPath
.\scripts\serve-detached.ps1 -Port 5200 -DataDir "$short\" --no-browser   # recognized as reattach, NOT a 2nd listener
```
Expected: both print the staleness warning and the existing handle; no second backend; no `LockfileManager` collision.

- [ ] **Step 4: `-Stop` teardown + re-stop idempotent (smoke 6)**

```powershell
.\scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-st
Get-NetTCPConnection -LocalPort 5200 -State Listen -ErrorAction SilentlyContinue   # nothing
.\scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-st   # "not running", exit 0
```
Expected: tree gone, pidfile removed, re-stop clean.

- [ ] **Step 5: `-SkipBuild` fast path (smoke 3)**

After a build is current, `-SkipBuild` returns ready with no foreground `npm`/`dotnet build` lines and a noticeably shorter wall-clock than Step 1.

- [ ] **Step 6: Build failures surface synchronously (smoke 4 + 4b)**

Introduce `package-lock.json` drift → launch *without* `-SkipBuild` → fails in the foreground with the `npm ci` error, **before** any detach (no pidfile, nothing listening). Repeat with a deliberate C# compile error → the foreground `run.ps1 -BuildOnly` `dotnet build PRism.Web` fails before detach. Revert both edits after.

- [ ] **Step 7: Parallel two-instance (smoke 5)**

Launch wt-0 (`-Port 5200 -DataDir …\PRism-wt-0`) and wt-1 (`-Port 5201 -DataDir …\PRism-wt-1`) from two checkouts. Both `/api/health` answer their own `dataDir`; pidfile/log/wrapper never collide. `-Stop` each.

- [ ] **Step 8: Port-in-use → FAIL default (smoke 8) + `-Force` (smoke 9, 17)**

With wt-0 on 5200, launch `-Port 5200` with a *different* `-DataDir` → fails with "different PRism store", does **not** kill wt-0. Repeat with `-Force` → occupant killed (name surfaced), new server up. Occupy 5200 with a foreign process (e.g. a `python -m http.server 5200`) and `-Force` → name surfaced, killed via the re-read window.

- [ ] **Step 9: Health-gate diagnostics (smoke 10, 10b)**

`-TimeoutSec 5` against a cold start (or a server that binds but never serves) → non-zero exit + **log tail** + wrapper PID + log path. Point at a deliberately broken wrapper path so the wrapper never writes → message says **"wrapper never wrote"**, not an empty tail. (The isolated logic was checked in Task 9; this confirms it live.)

- [ ] **Step 10: Recycle + stale-pidfile recovery (smoke 11, 11b, 14, 15)**

- Kill the server out-of-band leaving the pidfile → next launch succeeds (detects stale + free port); `-Stop` against the stale pidfile reports "not running".
- Hand-edit the pidfile `wrapperPid` to a live unrelated PID (Notepad) → `-Stop` does **not** kill it (name mismatch), cleans up.
- Kill only wrapper + `dotnet run`, leave the app → `-Stop` kills via the `ServerPid` fallback.
- Two near-simultaneous launches on one store → exactly one listener (second `Acquire` fails), both return a usable handle or the loser fails cleanly; subsequent `-Stop` tears down the live listener.

- [ ] **Step 11: `--no-browser` honored detached (smoke 16) + run.ps1 default (smoke 12) + platform guard (smoke 13)**

- Detached log shows no `BrowserLauncher` invocation.
- `./run.ps1 -Port 5212 -DataDir $env:TEMP\PRism-st2` (no new switch) builds + launches foreground unchanged.
- (If a non-Windows shell is available) the script fails fast with the POSIX-out-of-scope message.

- [ ] **Step 12: Final cleanup**

```powershell
.\scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-st
.\scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-st2
Remove-Item -Recurse -Force $env:TEMP\PRism-st, $env:TEMP\PRism-st2, $env:TEMP\PRism-wt-0, $env:TEMP\PRism-wt-1 -ErrorAction SilentlyContinue
```

---

## Self-review (run against the spec — completed at plan-write time)

**1. Spec coverage** — every §-numbered requirement maps to a task:
- §4.1 run.ps1 switches → Task 1. §4.2 launch flow → Task 10. §4.3 wrapper → Task 7. §4.4 detach → Task 8. §4.5 PID/teardown/-Force → Tasks 5, 11. §4.6 canonical dataDir + health identity → Tasks 3, 9. §4.7 pidfile → Task 6. §5 port-in-use branches → Task 10 (pre-check) + Task 5 (kill). §6 guards → Tasks 2, 12. §7 doc updates + log cleanup → Task 13. §9 smoke → Task 14. §10 acceptance → covered transitively by Tasks 1–14.
- No process-ancestry gate and no launch-lock (spec round-2 removed both) → correctly **absent** from the plan; identity is `health 200 + canonical-dataDir` (Task 9).

**2. Placeholder scan** — every code step carries the actual code; no "TBD"/"add error handling"/"similar to Task N". Verification steps give exact commands + expected output.

**3. Type/name consistency** — function names are consistent across tasks: `Get-CanonicalDataDir`, `Get-ServeDetachedPaths`, `Invoke-HealthProbe`, `Get-PortOwnerPid`, `Stop-ProcessIfMatches`, `Invoke-ForcePortReclaim`, `Write-Pidfile`/`Read-Pidfile`, `Limit-LogSize`, `Write-WrapperScript`, `Start-DetachedWrapper`, `Wait-ForHealth`/`Get-LaunchFailureMessage`, `Invoke-Launch`, `Invoke-Stop`. The handle shape `{ Pid; Url; Log; DataDir; Version }` is identical in Task 10's two return sites and matches §10. Pidfile fields (`wrapperPid`/`serverPid`/`port`/`url`/`dataDir`/`log`/`startedUtc`) match §4.7 and Task 6.

**Two flagged plan-time refinements** (top of doc): the dot-source testability seam and `dotnet build PRism.Web` (vs the spec's solution-wide `dotnet build`). Both are surfaced for the plan-review gate.

---

## ce-doc-review disposition log (2026-06-07)

One headless pass, four personas (coherence, feasibility, security-lens, scope-guardian). product-lens/adversarial skipped — the plan derives from an already-twice-reviewed, human-approved spec and introduces no new premise or abstraction.

| # | Reviewer | Finding | Sev/Conf | Disposition |
|---|----------|---------|----------|-------------|
| 1 | feasibility | Build-failure gate relies on maskable `$LASTEXITCODE` (native nonzero doesn't throw under EAP=Stop; last step's code wins) | P2 / 75 | **Applied** — Task 1 Step 3 now guards each native build step with an explicit `if ($LASTEXITCODE -ne 0){throw}`. Also resolves scope-guardian's deferred `$LASTEXITCODE` question. |
| 2 | scope-guardian | Dot-source seam: Task 2 verified suppression but not that a normal `&` invocation *runs* main | P2 / 75 | **Applied** — Task 2 Step 4 now checks both branches of the dispatch condition. |
| 3 | scope-guardian | `dotnet build PRism.Web` misses test-project restore errors vs spec's solution-wide build | P2 / 75 | **Applied (boundary made explicit)** — kept `PRism.Web` (right scope for a launcher); Task 1 Step 3 comment + the top-of-doc refinement now state the tradeoff and the one-line revert to solution-wide for the gate. |
| 4 | scope-guardian | Redundant 2nd `/api/health` probe for `version` after `Wait-ForHealth` (null-version race) | P3 / 75 | **Applied** — `Wait-ForHealth` now returns `{ ServerPid; Version }` from the same probe; Task 10 destructures it. |
| 5 | security-lens | Newline in a `DotnetArgs` element splits the authored wrapper (malformed → launch fails) | P3 / 50 (FYI) | **Applied** — Task 7 strips CR/LF per element; Task 7 verification adds a tricky-args parse check. Cheap defensive fix despite FYI anchor. |
| 6 | scope-guardian + coherence + feasibility | Hard-coded line numbers in Task 13 (and elsewhere) go stale after Task 1's edits / recent PRs | P3 / 50 (FYI) | **Applied** — Task 13 switched to content anchors with a "locate by content" note. |
| 7 | security-lens | `serve-detached.log` not cleaned on `-Reset Auth` | P3 / 50 (FYI) | **Skipped** — spec §4.3 deliberately scopes log cleanup to `-Reset Token`; `-Reset Auth` is host-config-only and `-Reset Full` wipes the whole store. Adding it to `Auth` expands scope the spec didn't authorize. |
| — | security-lens (residual) | Wrapper file persists after `-Stop` (non-secret; overwritten next launch) | — | **Skipped** — spec defines `-Stop` as tree-kill + remove-pidfile only; file is non-secret and self-overwriting. Noted for the owner. |
| — | coherence | Clean — 0 findings (verified handle shape, function names, pidfile fields, spec coverage all consistent) | — | — |
