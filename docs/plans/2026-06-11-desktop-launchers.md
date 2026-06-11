# Desktop Launchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two one-command launcher scripts (`scripts/run-desktop.ps1` for Windows, `scripts/run-desktop.sh` for macOS) that build the PRism desktop Electron app from a fresh clone and launch it detached, freeing the calling terminal.

**Architecture:** Each script runs a gating preflight (Node presence + .NET SDK ≥ 10 with copy-pasteable remediation), then builds the SPA → publishes a framework-dependent host-RID sidecar into a freshly-cleared `desktop/.dev-sidecar/` → builds the Electron TS → launches `electron .` detached with `PRISM_SIDECAR_BINARY` set and stdout/stderr captured to a log. Windows detaches via the `serve-detached.ps1` WMI **wrapper-script** pattern (a `Win32_Process.Create` command line carries neither env vars nor redirection); macOS detaches via `nohup … & disown`. Electron owns the sidecar child, so closing the window is full teardown. A pidfile guards against a second run rebuilding into a single-instance-lock no-op.

**Tech Stack:** PowerShell 7, Bash, .NET 10 (`dotnet publish`), Node 24 / npm, Electron (from-source `electron .`), WMI `Win32_Process.Create`.

**Spec:** `docs/specs/2026-06-11-desktop-launchers-design.md`

**Testing model:** Both scripts are structured as pure, sourceable functions behind a run-guard (mirroring `scripts/serve-detached.ps1`). The PowerShell helpers are unit-tested by dot-sourcing into `scripts/run-desktop.Tests.ps1`; the Bash helpers (SDK-major parse, arch→RID map, remediation) by `scripts/run-desktop.bash-tests.sh` — both plain assertion harnesses (the repo has no Pester suite; only Pester 3.4.0 is present). **Both harnesses run on the Windows dev machine** (the bash one via Git Bash/WSL), so logic/syntax bugs in either script are caught locally. What stays unverifiable on Windows is the **macOS runtime**: the detached `electron .` window, `nohup`/`disown` survival on macOS, Gatekeeper-on-first-run, and the real `arm64` host — a macOS tester confirms that half. The Windows integration glue (WMI spawn, `electron .`, builds) is owner-verified end-to-end.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `scripts/run-desktop.ps1` (create) | Windows launcher: pure helper functions + `Invoke-Main` orchestration behind a dot-source guard. |
| `scripts/run-desktop.Tests.ps1` (create) | Dot-source assertion harness for the pure functions in `run-desktop.ps1`. |
| `scripts/run-desktop.sh` (create) | macOS launcher: sourceable pure helpers + `main()` behind a source-guard; `nohup`+`disown` detach. Runtime tester-verified. |
| `scripts/run-desktop.bash-tests.sh` (create) | Bash assertion harness for `run-desktop.sh`'s pure helpers (SDK-major parse, arch→RID, remediation). Runs in Git Bash/WSL. |
| `desktop/.gitignore` (modify) | Add `.dev-sidecar/` (dev publish dir, kept separate from packaging `sidecar/`). |
| `desktop/README.md` (create) | Document both launchers, prerequisites, the macOS Gatekeeper remedy, and the deferred `run.ps1 -Mode Desktop` relationship. |

---

### Task 1: Scaffold the script, test harness, and gitignore

**Files:**
- Modify: `desktop/.gitignore`
- Create: `scripts/run-desktop.ps1`
- Create: `scripts/run-desktop.Tests.ps1`

- [ ] **Step 1: Add the dev-sidecar dir to desktop/.gitignore**

Open `desktop/.gitignore` and append (keep the existing `sidecar/` entry untouched):

```gitignore

# Framework-dependent dev sidecar published by scripts/run-desktop.* (NOT the
# packaging sidecar/ dir, which holds the self-contained CI-renamed artifact).
.dev-sidecar/
```

- [ ] **Step 2: Create the script skeleton with a dot-source main-guard**

Create `scripts/run-desktop.ps1`:

```powershell
#!/usr/bin/env pwsh
#requires -Version 7
<#
.SYNOPSIS
    Clone-and-run the PRism desktop (Electron) app on Windows, detached.
.DESCRIPTION
    One command for testers: preflight (Node + .NET SDK >= 10 with remediation),
    build the SPA, publish a framework-dependent win-x64 sidecar into
    desktop/.dev-sidecar/, build the Electron TS, then launch `electron .` DETACHED
    via the serve-detached.ps1 WMI wrapper pattern so the calling terminal is freed.
    Closing the window tears down the sidecar (Electron owns it). See
    docs/specs/2026-06-11-desktop-launchers-design.md.
.PARAMETER SkipBuild
    Skip the build/publish steps and launch against the current desktop/.dev-sidecar/
    output. For fast re-launches once a build is current.
.EXAMPLE
    scripts\run-desktop.ps1
.EXAMPLE
    scripts\run-desktop.ps1 -SkipBuild
#>
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pure, dot-sourceable helpers below. The main-guard at the bottom keeps them
# importable into run-desktop.Tests.ps1 without executing the launch.
# ---------------------------------------------------------------------------

function Invoke-Main {
    param([switch]$SkipBuild)
    throw "Invoke-Main not yet implemented"
}

# --- main (skipped when dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main -SkipBuild:$SkipBuild
}
```

- [ ] **Step 3: Create the test harness**

Create `scripts/run-desktop.Tests.ps1`:

```powershell
#!/usr/bin/env pwsh
#requires -Version 7
# Dot-source assertion harness for run-desktop.ps1's pure functions. No Pester
# (the repo has none; only Pester 3.4.0 ships). Run: pwsh -File scripts/run-desktop.Tests.ps1
$ErrorActionPreference = 'Stop'

# Dot-source the script under test. The main-guard (InvocationName -eq '.') keeps
# Invoke-Main from running on import.
. (Join-Path $PSScriptRoot 'run-desktop.ps1')

$script:Failures = 0
function Assert-True {
    param([bool]$Cond, [string]$Msg)
    if ($Cond) { Write-Host "  PASS: $Msg" -ForegroundColor Green }
    else { Write-Host "  FAIL: $Msg" -ForegroundColor Red; $script:Failures++ }
}
function Assert-Equal {
    param($Expected, $Actual, [string]$Msg)
    Assert-True ($Expected -eq $Actual) "$Msg (expected '$Expected', got '$Actual')"
}
function Assert-Match {
    param([string]$Text, [string]$Pattern, [string]$Msg)
    Assert-True ($Text -match $Pattern) "$Msg (pattern '$Pattern' not found)"
}

Write-Host "run-desktop.ps1 unit tests" -ForegroundColor Cyan

# === test blocks are appended here by later tasks ===

# --- footer: exit non-zero on any failure ---
if ($script:Failures -gt 0) {
    Write-Host "$script:Failures test(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "All tests passed" -ForegroundColor Green
```

- [ ] **Step 4: Run the harness to confirm it loads and passes with zero tests**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: prints `run-desktop.ps1 unit tests` then `All tests passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add desktop/.gitignore scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit -m "scaffold(#306): run-desktop.ps1 skeleton + dot-source test harness + .dev-sidecar gitignore"
```

---

### Task 2: .NET SDK preflight parsing

**Files:**
- Modify: `scripts/run-desktop.ps1` (add `Get-DotnetSdkMajors`, `Test-HasDotnetSdkAtLeast`)
- Test: `scripts/run-desktop.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

In `run-desktop.Tests.ps1`, insert before the `# --- footer` line:

```powershell
Write-Host "Get-DotnetSdkMajors / Test-HasDotnetSdkAtLeast" -ForegroundColor Cyan
$sample = @(
    '8.0.404 [C:\Program Files\dotnet\sdk]',
    '10.0.100 [C:\Program Files\dotnet\sdk]'
)
$majors = Get-DotnetSdkMajors -ListSdksOutput $sample
Assert-True ($majors -contains 8)  "parses major 8"
Assert-True ($majors -contains 10) "parses major 10"
Assert-Equal 0 (Get-DotnetSdkMajors -ListSdksOutput @()).Count "empty input -> no majors"
Assert-True  (Test-HasDotnetSdkAtLeast -ListSdksOutput $sample -MinMajor 10) "has >= 10 when 10.0.100 present"
Assert-True  (-not (Test-HasDotnetSdkAtLeast -ListSdksOutput @('8.0.404 [x]') -MinMajor 10)) "no >= 10 when only 8.x"
Assert-True  (-not (Test-HasDotnetSdkAtLeast -ListSdksOutput @('garbage line') -MinMajor 10)) "non-version line ignored"
```

- [ ] **Step 2: Run to verify failure**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: FAIL — `Get-DotnetSdkMajors` is not recognized (CommandNotFoundException).

- [ ] **Step 3: Implement the functions**

In `run-desktop.ps1`, add above `function Invoke-Main`:

```powershell
function Get-DotnetSdkMajors {
    # Parse `dotnet --list-sdks` lines (e.g. "10.0.100 [C:\Program Files\dotnet\sdk]")
    # into a sorted-unique list of integer major versions. Non-matching lines are
    # ignored; empty input yields an empty array.
    param([string[]]$ListSdksOutput)
    $majors = foreach ($line in $ListSdksOutput) {
        if ($line -match '^\s*(\d+)\.\d+\.\d+') { [int]$Matches[1] }
    }
    return @($majors | Sort-Object -Unique)
}

function Test-HasDotnetSdkAtLeast {
    # True if any installed SDK major version is >= $MinMajor.
    param([string[]]$ListSdksOutput, [int]$MinMajor)
    return (@(Get-DotnetSdkMajors -ListSdksOutput $ListSdksOutput | Where-Object { $_ -ge $MinMajor })).Count -gt 0
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: all six new assertions PASS; `All tests passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit -m "feat(#306): .NET SDK >=10 preflight parsing for run-desktop.ps1"
```

---

### Task 3: Preflight remediation messages

**Files:**
- Modify: `scripts/run-desktop.ps1` (add `Get-NodeRemediation`, `Get-DotnetRemediation`)
- Test: `scripts/run-desktop.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

Insert before the footer:

```powershell
Write-Host "remediation messages" -ForegroundColor Cyan
$nodeMsg = Get-NodeRemediation
Assert-Match $nodeMsg 'winget install OpenJS\.NodeJS\.LTS' "node remediation names winget package"
Assert-Match $nodeMsg 'Node 24' "node remediation names recommended version"
$dnMsg = Get-DotnetRemediation
Assert-Match $dnMsg 'Microsoft\.DotNet\.SDK\.10' "dotnet remediation names SDK 10 winget package"
Assert-Match $dnMsg '\.NET 10' "dotnet remediation names .NET 10"
```

- [ ] **Step 2: Run to verify failure**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: FAIL — `Get-NodeRemediation` not recognized.

- [ ] **Step 3: Implement**

Add above `function Invoke-Main`:

```powershell
function Get-NodeRemediation {
    return @'
Node.js / npm was not found on PATH.
  Windows: winget install OpenJS.NodeJS.LTS
  (or download from https://nodejs.org/ — CI builds on Node 24, the recommended version)
After installing, open a new terminal so PATH refreshes, then re-run this script.
'@
}

function Get-DotnetRemediation {
    param([string[]]$FoundSdks = @())
    $found = if ($FoundSdks.Count -gt 0) { "Found SDK(s): $($FoundSdks -join ', ')." } else { "No .NET SDK found." }
    return @"
A .NET 10 SDK is required to publish the PRism sidecar (the solution targets net10.0).
  $found
  Windows: winget install Microsoft.DotNet.SDK.10
  (or download the .NET 10 SDK from https://dotnet.microsoft.com/download/dotnet/10.0)
After installing, open a new terminal so PATH refreshes, then re-run this script.
"@
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: new assertions PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit -m "feat(#306): preflight remediation messages for run-desktop.ps1"
```

---

### Task 4: Host RID and sidecar apphost path

**Files:**
- Modify: `scripts/run-desktop.ps1` (add `Get-HostRid`, `Get-SidecarApphostPath`)
- Test: `scripts/run-desktop.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

Insert before the footer:

```powershell
Write-Host "Get-HostRid / Get-SidecarApphostPath" -ForegroundColor Cyan
Assert-Equal 'win-x64' (Get-HostRid) "Windows RID is win-x64"
$apphost = Get-SidecarApphostPath -PublishDir 'C:\repo\desktop\.dev-sidecar'
Assert-Equal 'C:\repo\desktop\.dev-sidecar\PRism.Web.exe' $apphost "apphost is PRism.Web.exe under publish dir"
```

- [ ] **Step 2: Run to verify failure**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: FAIL — `Get-HostRid` not recognized.

- [ ] **Step 3: Implement**

Add above `function Invoke-Main`:

```powershell
function Get-HostRid {
    # This Windows launcher only runs on Windows; the macOS RID (osx-arm64/osx-x64)
    # is handled by run-desktop.sh. win-x64 is the sole target here.
    return 'win-x64'
}

function Get-SidecarApphostPath {
    # The framework-dependent publish produces an apphost named after the assembly
    # (PRism.Web -> PRism.Web.exe). NOT the CI-renamed PRism-<rid> packaging artifact.
    param([string]$PublishDir)
    return (Join-Path $PublishDir 'PRism.Web.exe')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit -m "feat(#306): host RID + sidecar apphost path helpers"
```

---

### Task 5: WMI wrapper-script generator

**Files:**
- Modify: `scripts/run-desktop.ps1` (add `New-DesktopLauncherWrapper`)
- Test: `scripts/run-desktop.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

Insert before the footer:

```powershell
Write-Host "New-DesktopLauncherWrapper" -ForegroundColor Cyan
$wrapper = New-DesktopLauncherWrapper `
    -ElectronExe 'C:\repo\desktop\node_modules\.bin\electron.cmd' `
    -DesktopDir  'C:\repo\desktop' `
    -SidecarBinary 'C:\repo\desktop\.dev-sidecar\PRism.Web.exe' `
    -Log 'C:\data\run-desktop.log' `
    -StartedUtc '2026-06-11T00:00:00Z'
Assert-Match $wrapper "\`$env:PRISM_SIDECAR_BINARY = 'C:\\repo\\desktop\\\.dev-sidecar\\PRism\.Web\.exe'" "wrapper sets PRISM_SIDECAR_BINARY"
Assert-Match $wrapper "Set-Location 'C:\\repo\\desktop'" "wrapper cd's to desktop dir"
Assert-Match $wrapper "\*>> \`\$log" "wrapper redirects electron output to log"
Assert-Match $wrapper "electron\.cmd' \." "wrapper invokes electron with ."
# Embedded single-quote in a path must be doubled (PowerShell literal escaping):
$q = New-DesktopLauncherWrapper -ElectronExe "e" -DesktopDir "d'x" -SidecarBinary "s" -Log "l" -StartedUtc "t"
Assert-Match $q "Set-Location 'd''x'" "single-quote in path is doubled"
```

- [ ] **Step 2: Run to verify failure**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: FAIL — `New-DesktopLauncherWrapper` not recognized.

- [ ] **Step 3: Implement**

Add above `function Invoke-Main`:

```powershell
function New-DesktopLauncherWrapper {
    # Build the disposable wrapper .ps1 launched via WMI. A Win32_Process.Create
    # command line carries NEITHER env vars NOR redirection operators, so the wrapper
    # owns both: it sets PRISM_SIDECAR_BINARY, cd's to desktop/, and runs `electron .`
    # with its own *>> redirection. Single-quote every interpolated path (doubling
    # embedded quotes) so a space/quote in a path cannot break the script. Same
    # technique as scripts/serve-detached.ps1:Write-WrapperScript.
    param(
        [string]$ElectronExe,
        [string]$DesktopDir,
        [string]$SidecarBinary,
        [string]$Log,
        [string]$StartedUtc
    )
    $qLog      = "'" + ($Log -replace "'", "''") + "'"
    $qSidecar  = "'" + ($SidecarBinary -replace "'", "''") + "'"
    $qDesktop  = "'" + ($DesktopDir -replace "'", "''") + "'"
    $qElectron = "'" + ($ElectronExe -replace "'", "''") + "'"
    return @"
# run-desktop.wrapper.ps1 -- AUTHORED AT RUNTIME, disposable, overwritten each launch.
# Owns its own env + redirection so the WMI command line carries none.
`$ErrorActionPreference = 'Stop'
`$log = $qLog
`$env:PRISM_SIDECAR_BINARY = $qSidecar
"=== run-desktop launch @ $StartedUtc ===" *>> `$log
Set-Location $qDesktop
& $qElectron . *>> `$log
"@
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit -m "feat(#306): WMI wrapper-script generator (env + redirection)"
```

---

### Task 6: Already-running pidfile guard

**Files:**
- Modify: `scripts/run-desktop.ps1` (add `Get-LauncherPidfilePath`, `Test-LauncherAlreadyRunning`, `Write-LauncherPidfile`)
- Test: `scripts/run-desktop.Tests.ps1`

- [ ] **Step 1: Write the failing tests**

Insert before the footer:

```powershell
Write-Host "pidfile guard" -ForegroundColor Cyan
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rd-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $pf = Get-LauncherPidfilePath -DataDir $tmp
    Assert-Equal (Join-Path $tmp 'run-desktop.pid') $pf "pidfile path under data dir"
    Assert-True (-not (Test-LauncherAlreadyRunning -PidfilePath $pf)) "absent pidfile -> not running"
    # A pidfile naming THIS process (pwsh) with pwsh in the expected set -> running.
    Write-LauncherPidfile -PidfilePath $pf -ProcessId $PID
    $thisName = (Get-Process -Id $PID).Name
    Assert-True (Test-LauncherAlreadyRunning -PidfilePath $pf -ExpectedNames @($thisName)) "live PID with matching name -> running"
    # A bogus/dead PID -> not running.
    Write-LauncherPidfile -PidfilePath $pf -ProcessId 999999
    Assert-True (-not (Test-LauncherAlreadyRunning -PidfilePath $pf)) "dead PID -> not running"
    # A live PID whose name is NOT in the expected set (recycle guard) -> not running.
    Write-LauncherPidfile -PidfilePath $pf -ProcessId $PID
    Assert-True (-not (Test-LauncherAlreadyRunning -PidfilePath $pf -ExpectedNames @('definitely-not-this'))) "name mismatch -> not running (recycle guard)"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: FAIL — `Get-LauncherPidfilePath` not recognized.

- [ ] **Step 3: Implement**

Add above `function Invoke-Main`:

```powershell
function Get-LauncherPidfilePath {
    param([string]$DataDir)
    return (Join-Path $DataDir 'run-desktop.pid')
}

function Write-LauncherPidfile {
    param([string]$PidfilePath, [int]$ProcessId)
    [System.IO.File]::WriteAllText($PidfilePath, "$ProcessId", [System.Text.UTF8Encoding]::new($false))
}

function Test-LauncherAlreadyRunning {
    # True only if the pidfile names a LIVE process whose name is in $ExpectedNames.
    # The recycle guard (name check) mirrors serve-detached.ps1:Stop-ProcessIfMatches:
    # a 32-bit PID recycles fast, so a stale pidfile PID may now be an unrelated app.
    # The wrapper pwsh stays alive as electron's parent, so 'pwsh' is the live owner;
    # 'electron' is included for the macOS-style direct case / defensiveness.
    param([string]$PidfilePath, [string[]]$ExpectedNames = @('pwsh', 'electron'))
    if (-not (Test-Path -LiteralPath $PidfilePath)) { return $false }
    $raw = Get-Content -LiteralPath $PidfilePath -Raw -ErrorAction SilentlyContinue
    if (-not ($raw -match '^\s*(\d+)\s*$')) { return $false }
    $procId = [int]$Matches[1]
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    return $ExpectedNames -contains $p.Name
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-desktop.ps1 scripts/run-desktop.Tests.ps1
git commit -m "feat(#306): already-running pidfile guard with recycle check"
```

---

### Task 7: Assemble Invoke-Main (Windows orchestration)

**Files:**
- Modify: `scripts/run-desktop.ps1` (add `Assert-Platform`, `Assert-CommandPresent`, `Invoke-Preflight`; replace the `Invoke-Main` stub)

This is integration glue (process launch, WMI, builds) — not unit-tested. Verified end-to-end in Task 10.

- [ ] **Step 1: Replace the Invoke-Main stub with the full orchestration**

Replace the entire `function Invoke-Main { ... }` stub in `run-desktop.ps1` with:

```powershell
function Assert-Platform {
    if (-not $IsWindows) {
        throw "run-desktop.ps1 is the Windows launcher. On macOS run scripts/run-desktop.sh instead."
    }
}

function Assert-CommandPresent {
    param([string]$Name, [string]$Remediation)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host $Remediation -ForegroundColor Yellow
        throw "Preflight failed: '$Name' not found on PATH."
    }
}

function Invoke-Preflight {
    # Node + npm presence; .NET SDK major >= 10. On any miss, print remediation and throw.
    Assert-CommandPresent -Name 'node' -Remediation (Get-NodeRemediation)
    Assert-CommandPresent -Name 'npm'  -Remediation (Get-NodeRemediation)
    Assert-CommandPresent -Name 'dotnet' -Remediation (Get-DotnetRemediation)
    $sdks = @(& dotnet --list-sdks)
    if (-not (Test-HasDotnetSdkAtLeast -ListSdksOutput $sdks -MinMajor 10)) {
        $majors = (Get-DotnetSdkMajors -ListSdksOutput $sdks) -join ', '
        Write-Host (Get-DotnetRemediation -FoundSdks @($sdks)) -ForegroundColor Yellow
        throw "Preflight failed: no .NET SDK with major >= 10 (found majors: $majors)."
    }
}

function Invoke-Main {
    param([switch]$SkipBuild)
    Assert-Platform
    $repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $desktopDir = Join-Path $repoRoot 'desktop'
    $publishDir = Join-Path $desktopDir '.dev-sidecar'
    $dataDir    = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
    $log        = Join-Path $dataDir 'run-desktop.log'
    $pidfile    = Get-LauncherPidfilePath -DataDir $dataDir
    New-Item -ItemType Directory -Force $dataDir | Out-Null

    # Single-instance short-circuit BEFORE the (slow) build, so a re-run while the
    # app is up doesn't rebuild into an Electron single-instance-lock no-op.
    if (Test-LauncherAlreadyRunning -PidfilePath $pidfile) {
        Write-Host "PRism desktop is already running (pidfile $pidfile). Close the window first; a re-run would just refocus it. Nothing rebuilt." -ForegroundColor Yellow
        return
    }

    Invoke-Preflight

    if (-not $SkipBuild) {
        # 1. Frontend SPA -> PRism.Web/wwwroot
        Push-Location (Join-Path $repoRoot 'frontend')
        try {
            npm ci;        if ($LASTEXITCODE -ne 0) { throw "frontend npm ci failed ($LASTEXITCODE)." }
            npm run build; if ($LASTEXITCODE -ne 0) { throw "frontend npm run build failed ($LASTEXITCODE)." }
        } finally { Pop-Location }

        # 2. Sidecar: clean publish dir, then framework-dependent win-x64 publish.
        if (Test-Path -LiteralPath $publishDir) { Remove-Item -Recurse -Force $publishDir }
        dotnet publish (Join-Path $repoRoot 'PRism.Web/PRism.Web.csproj') `
            -c Release -r (Get-HostRid) --self-contained false -o $publishDir
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)." }

        # 3. Electron TS -> desktop/dist/main.js
        Push-Location $desktopDir
        try {
            npm ci;        if ($LASTEXITCODE -ne 0) { throw "desktop npm ci failed ($LASTEXITCODE)." }
            npm run build; if ($LASTEXITCODE -ne 0) { throw "desktop npm run build failed ($LASTEXITCODE)." }
        } finally { Pop-Location }
    }

    # 4. Resolve the published apphost + local electron shim; both must exist.
    $sidecar  = Get-SidecarApphostPath -PublishDir $publishDir
    if (-not (Test-Path -LiteralPath $sidecar)) {
        throw "Sidecar binary not found at $sidecar. Run without -SkipBuild to build it."
    }
    $electron = Join-Path $desktopDir 'node_modules\.bin\electron.cmd'
    if (-not (Test-Path -LiteralPath $electron)) {
        throw "Electron not found at $electron. Run without -SkipBuild so 'npm ci' installs it."
    }

    # 5. Author the wrapper (owns env + redirection), spawn it detached via WMI.
    $startedUtc  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $wrapperPath = Join-Path $dataDir 'run-desktop.wrapper.ps1'
    $wrapper     = New-DesktopLauncherWrapper -ElectronExe $electron -DesktopDir $desktopDir `
        -SidecarBinary $sidecar -Log $log -StartedUtc $startedUtc
    [System.IO.File]::WriteAllText($wrapperPath, $wrapper, [System.Text.UTF8Encoding]::new($false))

    $cmd = "pwsh -NoProfile -ExecutionPolicy Bypass -File `"$wrapperPath`""
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmd; CurrentDirectory = $desktopDir }
    if ($res.ReturnValue -ne 0) {
        throw "WMI Win32_Process.Create refused to spawn the wrapper (ReturnValue=$($res.ReturnValue))."
    }
    Write-LauncherPidfile -PidfilePath $pidfile -ProcessId ([int]$res.ProcessId)

    Write-Host "PRism desktop launching (detached). The window should appear shortly." -ForegroundColor Green
    Write-Host "  If it stays blank or never appears, inspect: $log" -ForegroundColor DarkGray
    Write-Host "  Close the window to stop (the sidecar shuts down with it)." -ForegroundColor DarkGray
}
```

- [ ] **Step 2: Confirm the unit tests still pass (functions unchanged, dot-source still clean)**

Run: `pwsh -File scripts/run-desktop.Tests.ps1`
Expected: `All tests passed`, exit 0 (the new `Assert-*`/`Invoke-*` functions don't run on dot-source).

- [ ] **Step 3: Commit**

```bash
git add scripts/run-desktop.ps1
git commit -m "feat(#306): assemble run-desktop.ps1 main orchestration (preflight->build->detach)"
```

---

### Task 8: macOS launcher (run-desktop.sh) + bash logic tests

**Files:**
- Create: `scripts/run-desktop.sh`
- Create: `scripts/run-desktop.bash-tests.sh`

The macOS **runtime** (detached `electron .`, `nohup`+`disown` survival on macOS, Gatekeeper, the real `arm64` host) **cannot be exercised on the Windows dev machine** — that half is verified by a macOS tester (Task 10). But the script's **pure shell logic** (SDK-major parse, arch→RID map, remediation text) is factored into sourceable functions and unit-tested via a bash harness that runs fine in Git Bash or WSL on Windows. That catches logic/syntax bugs locally so the Mac tester only has to confirm runtime behavior. Keep the script behaviorally aligned with `run-desktop.ps1`.

- [ ] **Step 1: Create the script (sourceable helpers + main-guard)**

Create `scripts/run-desktop.sh`. Note the structure: pure helpers have **no side effects at source time**; all the executable flow lives in `main()`, run only when the file is executed directly (so the test harness can `source` it without launching anything).

```bash
#!/usr/bin/env bash
# Clone-and-run the PRism desktop (Electron) app on macOS, detached.
# One command for testers: preflight (Node + .NET SDK >= 10 with remediation),
# build the SPA, publish a framework-dependent host-RID sidecar into
# desktop/.dev-sidecar/, build the Electron TS, then launch `electron .` DETACHED
# via nohup+disown so the calling terminal is freed. Closing the window tears down
# the sidecar (Electron owns it). See docs/specs/2026-06-11-desktop-launchers-design.md.
#
# Usage:
#   ./scripts/run-desktop.sh            # build + launch
#   ./scripts/run-desktop.sh --skip-build

# ---- pure helpers (sourceable; no side effects at source time) ----

node_remediation() {
  cat >&2 <<'EOF'
Node.js / npm was not found on PATH.
  macOS: brew install node
  (or download from https://nodejs.org/ — CI builds on Node 24, the recommended version)
After installing, open a new terminal so PATH refreshes, then re-run this script.
EOF
}

dotnet_remediation() {
  cat >&2 <<EOF
A .NET 10 SDK is required to publish the PRism sidecar (the solution targets net10.0).
  ${1:-No .NET SDK found.}
  macOS: brew install --cask dotnet-sdk   (verify it provides .NET 10; otherwise use the official installer)
  Official: https://dotnet.microsoft.com/download/dotnet/10.0
After installing, open a new terminal so PATH refreshes, then re-run this script.
EOF
}

# Read `dotnet --list-sdks`-style lines on stdin; echo the highest major (e.g.
# "10.0.100 [..]" -> 10), or nothing if no version line is present.
dotnet_sdk_max_major() {
  sed -n 's/^\([0-9][0-9]*\)\..*/\1/p' | sort -n | tail -1
}

# Map a `uname -m` arch to the sidecar RID. Echo the RID, or return 1 (unsupported).
rid_for_arch() {
  case "$1" in
    arm64)  echo "osx-arm64" ;;
    x86_64) echo "osx-x64" ;;
    *) return 1 ;;
  esac
}

main() {
  set -euo pipefail

  local skip_build=0
  [[ "${1:-}" == "--skip-build" ]] && skip_build=1

  local repo_root desktop_dir publish_dir data_dir log pidfile
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  desktop_dir="$repo_root/desktop"
  publish_dir="$desktop_dir/.dev-sidecar"
  # .NET's Environment.SpecialFolder.LocalApplicationData resolves to ~/.local/share on
  # macOS (XDG) — where the sidecar's DataDirectoryResolver self-resolves the store. Match
  # it so the log/pidfile sit beside the real data dir (NOT ~/Library/Application Support,
  # which the app never uses).
  data_dir="${PRISM_DATA_DIR:-$HOME/.local/share/PRism}"
  log="$data_dir/run-desktop.log"
  pidfile="$data_dir/run-desktop.pid"
  mkdir -p "$data_dir"

  # --- preflight: Node + npm presence, .NET SDK major >= 10 ---
  command -v node   >/dev/null 2>&1 || { node_remediation;   exit 1; }
  command -v npm    >/dev/null 2>&1 || { node_remediation;   exit 1; }
  command -v dotnet >/dev/null 2>&1 || { dotnet_remediation; exit 1; }

  local max_major
  max_major="$(dotnet --list-sdks | dotnet_sdk_max_major)"
  if [[ -z "$max_major" || "$max_major" -lt 10 ]]; then
    dotnet_remediation "Found SDK major: ${max_major:-none}."
    exit 1
  fi

  # --- single-instance short-circuit BEFORE the slow build ---
  if [[ -f "$pidfile" ]]; then
    local existing_pid
    existing_pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "PRism desktop is already running (pid $existing_pid). Close the window first; a re-run would just refocus it. Nothing rebuilt." >&2
      exit 0
    fi
  fi

  # --- host RID from arch ---
  local rid
  if ! rid="$(rid_for_arch "$(uname -m)")"; then
    echo "Unsupported macOS arch: $(uname -m)" >&2
    exit 1
  fi

  if [[ "$skip_build" -eq 0 ]]; then
    # 1. Frontend SPA -> PRism.Web/wwwroot
    ( cd "$repo_root/frontend" && npm ci && npm run build )
    # 2. Sidecar: clean publish dir, framework-dependent host-RID publish
    rm -rf "$publish_dir"
    dotnet publish "$repo_root/PRism.Web/PRism.Web.csproj" \
      -c Release -r "$rid" --self-contained false -o "$publish_dir"
    # 3. Electron TS -> desktop/dist/main.js
    ( cd "$desktop_dir" && npm ci && npm run build )
  fi

  # 4. Resolve apphost + electron; both must exist.
  local sidecar electron
  sidecar="$publish_dir/PRism.Web"
  electron="$desktop_dir/node_modules/.bin/electron"
  [[ -f "$sidecar" ]]  || { echo "Sidecar not found at $sidecar. Run without --skip-build." >&2; exit 1; }
  [[ -x "$electron" ]] || { echo "Electron not found at $electron. Run without --skip-build so 'npm ci' installs it." >&2; exit 1; }

  # 5. Launch detached. nohup ignores SIGHUP; disown drops the job so closing
  #    Terminal doesn't kill Electron (or the sidecar it owns).
  echo "=== run-desktop launch @ $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$log"
  (
    cd "$desktop_dir"
    export PRISM_SIDECAR_BINARY="$sidecar"
    nohup "$electron" . >>"$log" 2>&1 &
    echo $! >"$pidfile"
    disown
  )

  echo "PRism desktop launching (detached). The window should appear shortly."
  echo "  If the sidecar fails to start, Electron shows an error dialog; for more, see: $log"
  echo "  Close the window to stop (the sidecar shuts down with it)."
  echo "  Gatekeeper note: if macOS blocks Electron on first run, right-click the app and choose Open,"
  echo "  or run: xattr -dr com.apple.quarantine \"$desktop_dir/node_modules/electron\""
}

# Run main only when executed directly, not when sourced by the test harness.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
```

- [ ] **Step 2: Create the bash test harness**

Create `scripts/run-desktop.bash-tests.sh`:

```bash
#!/usr/bin/env bash
# Unit tests for run-desktop.sh's pure helpers. Sources the script (the main-guard
# keeps main() from running) and asserts. Runs anywhere bash runs — Git Bash or WSL
# on Windows is fine. Run: bash scripts/run-desktop.bash-tests.sh
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./run-desktop.sh
source "$HARNESS_DIR/run-desktop.sh"

fails=0
assert_eq() {  # expected actual msg
  if [[ "$1" == "$2" ]]; then echo "  PASS: $3"; else echo "  FAIL: $3 (expected '$1', got '$2')"; fails=$((fails + 1)); fi
}
assert_match() {  # text pattern msg
  if echo "$1" | grep -qE "$2"; then echo "  PASS: $3"; else echo "  FAIL: $3 (pattern '$2' not found)"; fails=$((fails + 1)); fi
}

echo "run-desktop.sh unit tests"

# dotnet_sdk_max_major
assert_eq "10" "$(printf '8.0.404 [x]\n10.0.100 [y]\n' | dotnet_sdk_max_major)" "max major across 8 and 10 is 10"
assert_eq ""   "$(printf 'garbage line\n'              | dotnet_sdk_max_major)" "no version line -> empty"

# rid_for_arch (this is the key macOS branch we can't reach via real uname on Windows)
assert_eq "osx-arm64" "$(rid_for_arch arm64)"  "arm64 -> osx-arm64"
assert_eq "osx-x64"   "$(rid_for_arch x86_64)" "x86_64 -> osx-x64"
if rid_for_arch ppc64 >/dev/null 2>&1; then
  echo "  FAIL: unsupported arch should return nonzero"; fails=$((fails + 1))
else
  echo "  PASS: unsupported arch returns nonzero"
fi

# remediation text
assert_match "$(node_remediation 2>&1)"   "brew install node" "node remediation names brew"
assert_match "$(dotnet_remediation 2>&1)" "\.NET 10"          "dotnet remediation references .NET 10"

if [[ "$fails" -gt 0 ]]; then echo "$fails test(s) failed"; exit 1; fi
echo "All tests passed"
```

- [ ] **Step 3: Run the harness (Git Bash or WSL on Windows)**

Run: `bash scripts/run-desktop.bash-tests.sh`
Expected: every assertion PASS; final `All tests passed`, exit 0. This validates the SDK-major parse, the `arm64`/`x86_64`→RID mapping, the unsupported-arch guard, and the remediation copy — without a Mac.

- [ ] **Step 4: Static checks**

Run:
```bash
bash -n scripts/run-desktop.sh && bash -n scripts/run-desktop.bash-tests.sh
command -v shellcheck >/dev/null 2>&1 && shellcheck scripts/run-desktop.sh scripts/run-desktop.bash-tests.sh || echo "shellcheck not installed — skipping (bash -n still ran)"
```
Expected: `bash -n` reports no syntax errors; shellcheck reports no errors (or the skip message).

- [ ] **Step 5: Mark executable in git and commit**

```bash
git add scripts/run-desktop.sh scripts/run-desktop.bash-tests.sh
git update-index --chmod=+x scripts/run-desktop.sh scripts/run-desktop.bash-tests.sh
git commit -m "feat(#306): macOS run-desktop.sh launcher + bash logic tests (runtime tester-verified)"
```

---

### Task 9: desktop/README.md

**Files:**
- Create: `desktop/README.md`

- [ ] **Step 1: Create the README**

Create `desktop/README.md`:

```markdown
# PRism Desktop (Electron shell)

The Electron shell that wraps the PRism web app as a desktop application. It spawns
the ASP.NET **sidecar** (`PRism.Web`) as a child process and loads the SPA the sidecar
serves.

## Run it from a clone (testers)

One command builds everything from source and launches the app **detached** — the
terminal is freed once the build finishes and the window appears.

```powershell
# Windows
scripts\run-desktop.ps1
scripts\run-desktop.ps1 -SkipBuild   # fast re-launch against the current build
```
```bash
# macOS
./scripts/run-desktop.sh
./scripts/run-desktop.sh --skip-build
```

**Prerequisites:** Node.js + npm (CI uses Node 24) and a **.NET 10 SDK**. The launcher
runs a preflight and prints exact install commands if either is missing — it builds
nothing until the toolchain is satisfied.

**Success signal:** the window appearing. The launcher does not health-gate (the
sidecar's port is reported to Electron, not the script). If the **sidecar fails to
start**, Electron raises a native error dialog ("PRism failed to start") — that is the
primary failure signal you see, even on a detached launch. The log it prints
(`run-desktop.log` in your PRism data dir) captures Electron's own stdout, including
the `[startup]` timing line, as supplementary diagnosis. (Electron consumes the
sidecar's own stdout/stderr through its spawn pipes, so the sidecar's port line and
backend stderr are not in this log.)

**Stop it:** close the window. Electron owns the sidecar, so it shuts down with the
window. A second launch while the app is up is short-circuited (it would otherwise
just refocus the existing window — Electron enforces a single instance).

**macOS Gatekeeper:** an npm-fetched Electron usually runs without a prompt. If macOS
blocks it on first run, right-click the app and choose **Open**, or clear the
quarantine flag once: `xattr -dr com.apple.quarantine desktop/node_modules/electron`.

## Relationship to `run.ps1`

`run.ps1` launches the **browser-tab** dev server, not the desktop shell. A foreground
`run.ps1 -Mode Desktop` dev-loop switch is **deferred** (see issue #306); these
launchers cover the standalone "run the app from a clone" path.

## How the launch works (maintainers)

1. **Preflight** — Node/npm presence, .NET SDK major ≥ 10, else remediation + exit.
2. **Build** — frontend SPA → `PRism.Web/wwwroot`; framework-dependent host-RID
   `dotnet publish` into a freshly-cleared `desktop/.dev-sidecar/` (separate from the
   packaging `desktop/sidecar/` dir); Electron `tsc`.
3. **Detach** — Windows uses the `serve-detached.ps1` WMI wrapper pattern (a
   `Win32_Process.Create` command line carries no env/redirection, so a generated
   wrapper sets `PRISM_SIDECAR_BINARY`, cd's to `desktop/`, and redirects to the log);
   macOS uses `nohup … & disown`.
```

- [ ] **Step 2: Commit**

```bash
git add desktop/README.md
git commit -m "docs(#306): desktop/README.md — launcher usage + prerequisites"
```

---

### Task 10: Owner end-to-end Windows verification + macOS tester hand-off

**Files:** none (verification task)

- [ ] **Step 1: Run both unit harnesses one final time**

Run:
```bash
pwsh -File scripts/run-desktop.Tests.ps1
bash scripts/run-desktop.bash-tests.sh   # Git Bash or WSL
```
Expected: both print `All tests passed`, exit 0. The bash harness validates the
`arm64`/`x86_64`→RID mapping and SDK-major parse locally even though the macOS *runtime*
can't be exercised here.

- [ ] **Step 2: Preflight-miss check (simulated)**

Temporarily confirm the remediation path prints by calling the preflight helper in a
subshell with a bogus PATH, or simply review that `Invoke-Preflight` prints
`Get-DotnetRemediation` before throwing. (Do not uninstall the SDK.) Confirm the
message names `Microsoft.DotNet.SDK.10`.

- [ ] **Step 3: Full Windows end-to-end launch**

> Note: if running inside the `D:/src/PRism-306` worktree, `frontend/node_modules` and
> `desktop/node_modules` may be junctions/empty (known worktree hazard). The script's
> `npm ci` populates them; if a junction points elsewhere, run from the main checkout
> after merge, or `npm ci` manually first.

Run: `scripts\run-desktop.ps1`
Expected: preflight passes; frontend build, `dotnet publish`, desktop build all
succeed; the terminal returns to a prompt; the **PRism desktop window appears** with
the SPA loaded (not blank). Confirm `run-desktop.log` in `%LOCALAPPDATA%\PRism` exists
and contains the `[startup]` line (the sidecar's own port line/stderr are not in this
log — they're consumed by Electron's spawn pipes; a sidecar-start failure instead
raises Electron's error dialog).

- [ ] **Step 4: Detach + teardown checks**

- Close the launching terminal — confirm the window stays up (detached).
- Re-run `scripts\run-desktop.ps1` while the window is open — confirm it short-circuits
  with "already running" and does **not** rebuild.
- Close the window — confirm the sidecar process (`PRism.Web`) exits (Task Manager / no
  orphan). Re-run with `-SkipBuild` — confirm it launches fast against the existing build.

- [ ] **Step 5: Hand off the macOS script**

The macOS path is unverified by the author. In the PR description, mark the macOS
acceptance criterion **unchecked** and request a macOS tester run `./scripts/run-desktop.sh`
end-to-end (build, detached launch, terminal-close survival, window-close teardown,
Gatekeeper behavior). #306 stays open until that confirmation lands.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(#306): verification fixups for run-desktop launchers"
```

---

## Self-Review Notes

- **Spec coverage:** preflight+remediation (Tasks 2–3, 7), framework-dependent host-RID publish with clean dir (Task 7/8), `.dev-sidecar` gitignore + separation (Task 1), WMI wrapper env+log (Tasks 5, 7), macOS nohup+disown (Task 8), single-instance guard (Tasks 6, 7/8), success-signal/log (Tasks 7–9), `-SkipBuild` (Tasks 1, 7, 8), Gatekeeper documented-not-baked (Tasks 8, 9), macOS merge-stance (Task 10), README (Task 9). All §10 acceptance criteria map to a task.
- **Type/name consistency:** PowerShell — `Get-DotnetSdkMajors`, `Test-HasDotnetSdkAtLeast`, `Get-HostRid`, `Get-SidecarApphostPath`, `New-DesktopLauncherWrapper`, `Get-LauncherPidfilePath`, `Write-LauncherPidfile`, `Test-LauncherAlreadyRunning`, `Invoke-Preflight`, `Invoke-Main`; Bash — `node_remediation`, `dotnet_remediation`, `dotnet_sdk_max_major`, `rid_for_arch`, `main` — names used identically across definition, tests, and callers.
- **Known constraint:** unit tests cover pure functions only (both PowerShell and Bash helpers, runnable on Windows); the detached-launch glue (WMI/`electron`/`nohup`) is verified manually — Windows by the owner (Task 10), macOS *runtime* by a tester. No automated harness for detached process launch exists in this repo, matching the `serve-detached.ps1` precedent.
```
