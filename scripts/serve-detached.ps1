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

function Assert-Platform {
    # Windows-only by design (spec section 2): the harness-reaping problem and its
    # WMI fix are Windows-specific, and Get-NetTCPConnection / taskkill / Win32_Process
    # do not exist on POSIX. Fail fast with a clear pointer rather than deep inside
    # the launch with a cryptic cmdlet-not-found.
    if (-not $IsWindows) {
        throw "serve-detached.ps1 is Windows-only (see spec section 2 'Out of scope: macOS / Linux'). On POSIX, setsid/nohup already survive; use run.ps1 directly."
    }
    # A locked-down sandbox / container may lack WMI. Probe cheaply so the failure
    # is interpretable rather than surfacing as a launch-time Invoke-CimMethod error.
    try {
        $null = Get-CimClass -ClassName Win32_Process -ErrorAction Stop
    } catch {
        throw "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn outside the harness job object. Run run.ps1 in the foreground instead. Underlying error: $($_.Exception.Message)"
    }
}

function Get-CanonicalDataDir {
    # Resolve -DataDir to ONE long-path absolute string and use that exact string
    # everywhere (run.ps1 --dataDir -> /api/health body, the health compare, the
    # pidfile, and transitively LockfileManager's lock path). Get-Item .FullName
    # expands 8.3 short names (%TEMP% often expands to PRATY~1\...) AND normalizes
    # casing; [IO.Path]::GetFullPath does NEITHER, which would make the health
    # compare miss a healthy server and let two launches key different lock paths
    # onto one store (spec section 4.6). Create the directory first so .FullName resolves.
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

function Invoke-HealthProbe {
    # GET /api/health: the only endpoint reachable from bare PowerShell (GET so
    # OriginCheckMiddleware doesn't apply; auth-exempt via IsLivenessEndpoint).
    # Returns the parsed body { port; version; dataDir } on a 200, else $null.
    # A connection-refused (nobody listening / still starting) is expected during
    # polling, not an error -- swallow it and return $null.
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

function Get-PortOwnerPid {
    # The app binds the 'localhost' hostname, so Kestrel listens on BOTH 127.0.0.1
    # and ::1 -> Get-NetTCPConnection returns TWO rows with the SAME OwningProcess.
    # Dedupe defensively (spec section 4.5). Returns the owning PID, or $null if free.
    param([int]$Port)
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue |
        Select-Object -Unique | Select-Object -First 1
    return $owner
}

function Stop-ProcessIfMatches {
    # PID-recycle guard (spec section 4.5; history: #107 LockfileManager recycled-PID
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

function Invoke-ForcePortReclaim {
    # -Force occupant kill (spec section 4.5/section 5). The occupant is FOREIGN, so
    # there is no name we recorded to compare. Defend against the recycle TOCTOU by
    # re-reading the owner immediately before killing: surface the name, then kill
    # THAT pid. If the port freed on its own -> nothing to do. If a NEW occupant
    # appeared -> re-probe (caller loops), don't fire at a stale pid.
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

function Write-Utf8NoBom {
    # Same helper run.ps1 uses (UTF-8, no BOM), so artifacts are byte-consistent.
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Write-Pidfile {
    # Per-store JSON pidfile (spec section 4.7). serverPid is filled after the health gate.
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

function Limit-LogSize {
    # The log is APPENDED per launch (so crash-loop evidence survives a relaunch),
    # so cap it: when it exceeds the threshold, keep the tail. Bounds append growth.
    param([string]$Log, [int]$MaxBytes = 5MB, [int]$KeepLines = 2000)
    if (-not (Test-Path -LiteralPath $Log)) { return }
    if ((Get-Item -LiteralPath $Log).Length -le $MaxBytes) { return }
    $tail = Get-Content -LiteralPath $Log -Tail $KeepLines
    Write-Utf8NoBom -Path $Log -Text (($tail -join [Environment]::NewLine) + [Environment]::NewLine)
}

function Write-WrapperScript {
    # Write the disposable wrapper that owns its own redirection (spec section 4.3).
    # This is the whole cause-3 fix: *>> $log is parsed as a redirection INSIDE this
    # real pwsh process, instead of becoming a literal arg on the WMI command line.
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
    $argTail = @('--no-browser') + @($DotnetArgs | Where-Object { $_ } | ForEach-Object { $_ -replace '[\r\n]+', ' ' })
    $argLiteral = ($argTail | ForEach-Object { "'$($_.Replace("'", "''"))'" }) -join ', '

    # run.ps1's $Reset is the position-0 ValidateSet param; a bare leading
    # --no-browser with no named -Reset binds positionally to $Reset and fails its
    # ValidateSet. Name -Reset None so pass-through args reach ValueFromRemainingArguments.
    $content = @"
# serve-detached.wrapper.ps1 -- AUTHORED AT RUNTIME, disposable, overwritten each launch.
# Owns its own redirection so the WMI command line carries none (spec cause 3).
`$ErrorActionPreference = 'Stop'
`$log = '$($Log.Replace("'", "''"))'
"=== serve-detached launch @ $StartedUtc port $Port ===" *>> `$log
& '$($runPs1.Replace("'", "''"))' -Reset None -SkipBuild -Port $Port -DataDir '$($DataDir.Replace("'", "''"))' $argLiteral *>> `$log
"@
    Write-Utf8NoBom -Path $WrapperPath -Text $content
}

function Start-DetachedWrapper {
    # Spawn the wrapper via WMI so it lands OUTSIDE the harness job object and
    # survives the tool call returning (spec cause 2 + section 4.4). CRITICAL: the
    # CommandLine carries NO redirection operators -- the wrapper owns those.
    # -ExecutionPolicy Bypass: the wrapper is an unsigned ephemeral file.
    # Returns the wrapper PID. Note ReturnValue==0 only means the OS CREATED the
    # process -- it does NOT prove the wrapper ran or wrote (see the gate diagnostics).
    param([string]$WrapperPath, [string]$RepoRoot)
    $cmd = "pwsh -NoProfile -ExecutionPolicy Bypass -File `"$WrapperPath`""
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmd; CurrentDirectory = $RepoRoot }
    if ($res.ReturnValue -ne 0) {
        throw "WMI Win32_Process.Create refused to spawn the wrapper (ReturnValue=$($res.ReturnValue)). The server was not launched."
    }
    return [int]$res.ProcessId
}

function Get-LaunchFailureMessage {
    # Empty-vs-populated log diagnostic (spec section 4.2 step 8, section 6). An
    # empty/absent log means the wrapper never ran (launch-shell / execution-policy /
    # unwritable-log); a populated log means the server started then exited (tail it).
    param([string]$Log, [int]$WrapperPid, [string]$Reason, [int]$Port = 0)
    $hasLog = (Test-Path -LiteralPath $Log) -and ((Get-Item -LiteralPath $Log).Length -gt 0)
    $head = if ($Reason -eq 'timeout') {
        "Health gate timed out waiting for http://localhost:$Port/api/health. The port may have been taken by another process after the pre-check."
    } else {
        "The launched wrapper (PID $WrapperPid) exited before the server answered."
    }
    if (-not $hasLog) {
        return "$head`nThe log at '$Log' is EMPTY -- the wrapper never wrote, which points to a launch-shell / execution-policy / unwritable-log error rather than a server crash."
    }
    $tail = (Get-Content -LiteralPath $Log -Tail 30) -join [Environment]::NewLine
    return "$head`nLog tail ($Log):`n$tail"
}

function Wait-ForHealth {
    # Poll /api/health until 200 AND body.dataDir matches the canonical store, or
    # the wrapper dies, or -TimeoutSec elapses (spec section 4.2 step 8 + section 4.6).
    # On READY, returns { ServerPid; Version } from the SAME probe that proved
    # readiness (so the caller needs no second /api/health round trip). On failure,
    # throws a message that distinguishes an EMPTY log (wrapper never wrote) from a
    # POPULATED log (server started but exited -- tail printed). No process-ancestry
    # check: Acquire-before-bind guarantees any listener for this store is the sole
    # legitimate instance.
    param(
        [int]$Port, [string]$CanonicalDataDir, [int]$TimeoutSec,
        [int]$WrapperPid, [string]$Log
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $body = Invoke-HealthProbe -Port $Port
        if ($null -ne $body -and ($body.dataDir.TrimEnd('\', '/') -ieq $CanonicalDataDir)) {
            # Carry $body.version out from the SAME probe that proved READY -- avoids
            # a redundant second probe (and the null-version race if the port flickers).
            return [pscustomobject]@{ ServerPid = (Get-PortOwnerPid -Port $Port); Version = $body.version }
        }
        # Fail fast if the wrapper died before the server ever answered.
        if (-not (Get-Process -Id $WrapperPid -ErrorAction SilentlyContinue)) {
            throw (Get-LaunchFailureMessage -Log $Log -WrapperPid $WrapperPid -Reason 'died')
        }
        Start-Sleep -Milliseconds 500
    }
    throw (Get-LaunchFailureMessage -Log $Log -WrapperPid $WrapperPid -Reason 'timeout' -Port $Port)
}

# --- main (skipped when the script is dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Assert-Platform
    # Mode dispatch + mutual-exclusion are wired in Task 12.
    throw "serve-detached.ps1 main body not yet implemented."
}
