# run.ps1 Reset Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `-Reset <None|Token|Auth|Full>` parameter to `run.ps1` so the developer can launch PRism with one of three pre-cleaned local-state shapes for testing setup, host-change, and first-launch scenarios.

**Architecture:** All changes are confined to `run.ps1`. The script runs the chosen reset operation against `<dataDir>` *before* `npm ci` / `npm run build` / `dotnet run`, so the host never has the lockfile or `state.json` open while files are being deleted. `<dataDir>` is resolved via `[Environment]::GetFolderPath('LocalApplicationData')` joined with `'PRism'`, mirroring `DataDirectoryResolver.Resolve()`. Pass-through args (e.g., `--no-browser`) continue to flow to `dotnet run` via a `ValueFromRemainingArguments` parameter.

**Tech Stack:** PowerShell — both Windows PowerShell 5.1 (`.NET Framework 4.x`) and PowerShell 7+ (`.NET 5+`). The existing `#!/usr/bin/env pwsh` shebang nominates pwsh 7, but the script must remain runnable under 5.1 so any developer's default PS host on Windows works. This means avoiding 7-only features: `Set-Content -Encoding utf8NoBOM` (use `[System.IO.File]::WriteAllText` with explicit `[System.Text.UTF8Encoding]::new($false)` instead), the 3-argument `[System.IO.File]::Move(src, dst, overwrite)` overload (use a direct write — power-loss safety falls through to the host's existing `state.json.corrupt-<timestamp>` recovery path). No new dependencies. No automated test framework — the spec ([`docs/superpowers/specs/2026-05-06-run-script-reset-design.md`](../specs/2026-05-06-run-script-reset-design.md) § 8) commits to a manual smoke checklist as the verification approach, since the C# behaviors each mode exercises are already covered by `tests/PRism.Core.Tests` and `tests/PRism.Web.Tests`.

**Spec:** [`docs/superpowers/specs/2026-05-06-run-script-reset-design.md`](../specs/2026-05-06-run-script-reset-design.md). Acceptance criteria in spec § 9.

**Post-implementation corrigendum (2026-05-06).** This plan was authored before discovering that `PRism.Core/Json/JsonSerializerOptionsFactory.cs` configures the storage serializer with `KebabCaseJsonNamingPolicy` and `PropertyNameCaseInsensitive = false`. Property names on disk are therefore kebab-case (`last-configured-github-host`, `review-sessions`, `ai-state`, `repo-clone-map`, `workspace-mtime-at-last-enumeration`), not the camelCase forms used in some code samples below. The shipped `run.ps1` and the spec (§ 4 Auth-mode subsection, § 9 acceptance) use the correct kebab-case keys throughout. Future consumers of this plan should refer to the spec for definitive property naming; the camelCase forms in this plan's code blocks are a historical artifact and would silently produce a state.json the host parses with `LastConfiguredGithubHost = null`, defeating Auth mode.

---

## Reference: current `run.ps1`

```powershell
#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    Push-Location frontend
    try {
        # `npm ci` is deterministic (refuses to run if package.json and
        # package-lock.json drift), unlike `npm install`. Always-run also
        # avoids leaving a stale node_modules behind a lockfile change.
        npm ci
        npm run build
    } finally {
        Pop-Location
    }

    dotnet run --project PRism.Web @args
} finally {
    Pop-Location
}
```

## Reference: file paths the modes touch

- **Token cache** (touched by `Token` and `Full`, **not** by `Auth`): `<dataDir>\PRism.tokens.cache` (and any `<dataDir>\PRism.tokens.cache.previous` left by MSAL Extensions during a torn write).
- **App state file** (touched by `Auth` and `Full`, **not** by `Token`): `<dataDir>\state.json` — top-level JSON object with a `lastConfiguredGithubHost` field (see [`PRism.Core/State/AppState.cs`](../../../PRism.Core/State/AppState.cs)). Other top-level keys: `version`, `reviewSessions`, `aiState`.
- **Data dir root** (only touched by `Full`): `<dataDir>` itself, where `<dataDir> = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'`.

## Reference: sentinel host

`Auth` mode writes the literal string `https://prism-reset-stub.invalid` into `state.json.lastConfiguredGithubHost`. The string is constant; it is defined once in `run.ps1` as `$ResetSentinelHost` and reused. The `.invalid` TLD is reserved by RFC 2606 and is guaranteed to never resolve to a real GitHub instance, so no real `config.github.host` value can collide with it.

## Smoke-testing convention used in every task

Each task ends with a manual smoke check that re-creates a known starting state in `<dataDir>` and runs `.\run.ps1 -Reset <mode>`. To avoid the multi-minute npm + dotnet pipeline during these checks, **press `Ctrl+C` once the reset banner has printed** — the banner fires *before* `npm ci`, so the dotnet host never starts. The task's "run end-to-end" verification (Task 6) is the single full pipeline run.

`<dataDir>` for the developer-running-this-plan is:

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
# On Windows: C:\Users\<user>\AppData\Local\PRism
```

To populate a known starting state for a smoke check:

```powershell
# Make sure PRism is not running first.
# State keys are kebab-case to match the host's KebabCaseJsonNamingPolicy
# (PRism.Core/Json/JsonSerializerOptionsFactory.cs). The encoding is UTF-8
# without BOM via the .NET API, which works in both PS 5.1 and PS 7+ (the
# `-Encoding utf8NoBOM` form on Set-Content is PS 7+ only).
New-Item -ItemType Directory -Force $dataDir | Out-Null
'placeholder-token-bytes' | Set-Content (Join-Path $dataDir 'PRism.tokens.cache') -NoNewline
$stateJson = (
    [ordered]@{
        'version' = 1
        'review-sessions' = @{}
        'ai-state' = [ordered]@{
            'repo-clone-map' = @{}
            'workspace-mtime-at-last-enumeration' = $null
        }
        'last-configured-github-host' = 'https://github.com'
    } | ConvertTo-Json -Depth 10
)
[System.IO.File]::WriteAllText(
    (Join-Path $dataDir 'state.json'),
    $stateJson,
    [System.Text.UTF8Encoding]::new($false)
)
'{}' | Set-Content (Join-Path $dataDir 'config.json')
```

Restore-from-backup convention: before any destructive smoke check, copy `<dataDir>` to `<dataDir>.bak.YYYYMMDD-HHmm` so the developer's actual session can be restored.

```powershell
$backupDir = "$dataDir.bak.$((Get-Date).ToString('yyyyMMdd-HHmm'))"
Copy-Item -Recurse $dataDir $backupDir
```

After the plan is verified, the backup can be removed manually.

---

### Task 1: Add `-Reset` parameter with `ValidateSet` + pass-through args

**Files:**
- Modify: `run.ps1`

**Goal:** Add the parameter signature and the `None` (no-op) branch. Pass-through args still flow to `dotnet run`. A typoed mode is rejected at parse time before any side effect.

- [ ] **Step 1: Reproduce the gap (test that fails first)**

Run:

```powershell
.\run.ps1 -Reset Garbage
```

Expected: PowerShell does *not* reject the unknown `-Reset` argument because no parameter is declared yet. The script proceeds to `npm ci` (which then fails or succeeds unrelated to our change). Press `Ctrl+C` immediately to stop. This confirms the gap.

- [ ] **Step 2: Add the `param()` block at the top of `run.ps1`**

Replace the current top of the file (lines 1–5) with:

```powershell
#!/usr/bin/env pwsh
# Build the frontend into PRism.Web/wwwroot, then launch PRism.Web.
# Pass-through args go to `dotnet run` (e.g. `./run.ps1 --no-browser`).
#
# -Reset selects an optional pre-launch local-state cleanup. Modes:
#   None  (default) — no cleanup; identical to running without the flag.
#   Token           — delete <dataDir>\PRism.tokens.cache. Forces Setup on next launch.
#   Auth            — set state.json.lastConfiguredGithubHost to a sentinel host
#                     (https://prism-reset-stub.invalid) so the next launch
#                     surfaces the host-change-resolution modal. Token cache
#                     is untouched.
#   Full            — wipe the entire <dataDir>. True first-launch reset.
#                     Caveat: on macOS / Linux the OS keychain entry survives;
#                     see the spec § 7 for the manual cleanup commands.
# See docs/superpowers/specs/2026-05-06-run-script-reset-design.md for rationale.
#
# Cross-platform note: on macOS / Linux the PAT lives in the OS keychain
# (Keychain / libsecret), not the cache file. -Reset Token deletes the file
# but does NOT clear the keychain entry on those platforms. The deferred
# in-app "Replace token" feature (S6) reuses TokenStore.ClearAsync, which
# is keychain-aware on every platform.
param(
    [ValidateSet('None', 'Token', 'Auth', 'Full')]
    [string]$Reset = 'None',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
)

$ErrorActionPreference = 'Stop'
```

- [ ] **Step 3: Replace `@args` with `@DotnetArgs` in the `dotnet run` invocation**

Change the line:

```powershell
    dotnet run --project PRism.Web @args
```

to:

```powershell
    dotnet run --project PRism.Web @DotnetArgs
```

- [ ] **Step 4: Verify the bad-mode rejection now fires**

Run:

```powershell
.\run.ps1 -Reset Garbage
```

Expected: PowerShell prints a parameter binding error like `Cannot validate argument on parameter 'Reset'. The argument "Garbage" does not belong to the set "None,Token,Auth,Full"…` and exits with a non-zero code *immediately*. No `npm ci` runs.

- [ ] **Step 5: Verify default invocation regression — pass-through still works**

Run (in an environment where `npm ci` and `dotnet run` would normally succeed against this branch — but you can `Ctrl+C` once `npm ci` starts to keep the test fast):

```powershell
.\run.ps1
.\run.ps1 --no-browser
.\run.ps1 -Reset None --no-browser
```

Expected: All three invocations begin `npm ci` immediately (no parameter errors). For the second and third, when `dotnet run` eventually starts, it receives `--no-browser`. (You don't need to wait for the dotnet phase to verify the flag handoff; correctness is implied if the script reaches `npm ci` without rejection.)

- [ ] **Step 6: Commit**

```powershell
git add run.ps1
git commit -m "$(@'
feat(run.ps1): add -Reset parameter scaffold (None default; rejects bad modes)

ValidateSet('None','Token','Auth','Full') means typoed modes fail at
parameter binding before any side effect. ValueFromRemainingArguments
captures pass-through args (e.g. --no-browser) so they still flow to
dotnet run after the param block is added.

Mode bodies (Token / Auth / Full) land in subsequent commits.

Refs docs/superpowers/specs/2026-05-06-run-script-reset-design.md
'@)"
```

---

### Task 2: Implement `-Reset Token` mode

**Files:**
- Modify: `run.ps1`

**Goal:** When `-Reset Token`, delete `<dataDir>\PRism.tokens.cache` (and any `.previous` companion) before the npm/dotnet pipeline. Print one status line. Idempotent: missing files are silent.

- [ ] **Step 1: Set up known-good state and confirm the gap**

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
$backupDir = "$dataDir.bak.$((Get-Date).ToString('yyyyMMdd-HHmm'))"
if (Test-Path $dataDir) { Copy-Item -Recurse $dataDir $backupDir }
New-Item -ItemType Directory -Force $dataDir | Out-Null
'placeholder-token-bytes' | Set-Content (Join-Path $dataDir 'PRism.tokens.cache') -NoNewline
Test-Path (Join-Path $dataDir 'PRism.tokens.cache')   # → True
.\run.ps1 -Reset Token                                 # Ctrl+C once npm ci starts
Test-Path (Join-Path $dataDir 'PRism.tokens.cache')   # → True (gap: deletion not implemented yet)
```

This confirms `-Reset Token` is a no-op as currently coded (Task 1's scaffold accepts the value but does nothing with it). The cache file should still exist.

- [ ] **Step 2: Add the reset dispatch block**

Insert this block in `run.ps1` *immediately after* the `$ErrorActionPreference = 'Stop'` line (which is the line right after the closing `)` of `param()`) and *before* `Push-Location $PSScriptRoot`:

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'

if ($Reset -ne 'None') {
    Write-Host "Reset($Reset): preparing to clean local state at $dataDir" -ForegroundColor Yellow
}

switch ($Reset) {
    'Token' {
        $tokenPath = Join-Path $dataDir 'PRism.tokens.cache'
        $previousPath = "$tokenPath.previous"
        Write-Host "  removing $tokenPath" -ForegroundColor DarkGray
        Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $previousPath -Force -ErrorAction SilentlyContinue
    }
    'Auth' { throw "Reset(Auth) not implemented yet — see Task 3." }
    'Full' { throw "Reset(Full) not implemented yet — see Task 4." }
}
```

The `throw` placeholders for `Auth` and `Full` keep the `switch` exhaustive while their bodies are still pending; they are replaced in Tasks 3 and 4. (Without them, choosing `Auth` or `Full` between commits would silently no-op, which is a worse failure mode than a clear error message.)

- [ ] **Step 3: Verify the deletion fires and is idempotent**

```powershell
$tokenPath = Join-Path $dataDir 'PRism.tokens.cache'
'placeholder-token-bytes' | Set-Content $tokenPath -NoNewline   # restore
Test-Path $tokenPath                                            # → True
.\run.ps1 -Reset Token                                          # Ctrl+C once npm ci starts
Test-Path $tokenPath                                            # → False (deletion fired)

# Idempotency: file is already gone
.\run.ps1 -Reset Token                                          # Ctrl+C once npm ci starts
# Expected: status banner prints, no error, no exit code != 0
```

- [ ] **Step 4: Verify `.previous` companion deletion**

```powershell
'placeholder' | Set-Content $tokenPath -NoNewline
'placeholder.previous' | Set-Content "$tokenPath.previous" -NoNewline
.\run.ps1 -Reset Token                                          # Ctrl+C once npm ci starts
Test-Path $tokenPath                                            # → False
Test-Path "$tokenPath.previous"                                 # → False
```

- [ ] **Step 5: Verify Auth and Full modes still throw (placeholder behavior)**

```powershell
.\run.ps1 -Reset Auth   # Expected: terminating error "Reset(Auth) not implemented yet…"
.\run.ps1 -Reset Full   # Expected: terminating error "Reset(Full) not implemented yet…"
```

This proves the placeholders keep `switch` exhaustive between commits.

- [ ] **Step 6: Commit**

```powershell
git add run.ps1
git commit -m "$(@'
feat(run.ps1): implement -Reset Token (cache file deletion)

Deletes <dataDir>\PRism.tokens.cache and any .previous torn-write
companion. Idempotent — missing files are silent. Auth and Full modes
still throw "not implemented yet" placeholders so an exhaustive switch
keeps the gap obvious between commits.

Refs docs/superpowers/specs/2026-05-06-run-script-reset-design.md § 4
'@)"
```

---

### Task 3: Implement `-Reset Auth` mode

**Files:**
- Modify: `run.ps1`

**Goal:** `-Reset Auth` sets `state.json.lastConfiguredGithubHost` to a sentinel value (`https://prism-reset-stub.invalid`) so the next launch's `/api/auth/state` probe reports a host mismatch and surfaces the host-change-resolution modal. The token cache is **not** touched (otherwise `/setup` would shadow the modal). If `state.json` is missing, it is created from the v1 default shape with the sentinel host. Aborts cleanly on malformed JSON.

- [ ] **Step 1: Set up known-good state — token present, populated state.json**

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
$tokenPath = Join-Path $dataDir 'PRism.tokens.cache'
$statePath = Join-Path $dataDir 'state.json'

'placeholder-token-bytes' | Set-Content $tokenPath -NoNewline
$initialState = [ordered]@{
    version = 1
    reviewSessions = @{ 'octocat/hello/1' = @{ pendingReviewId = 'PRR_kwAB123' } }
    aiState = @{ repoCloneMap = @{}; workspaceMtimeAtLastEnumeration = $null }
    lastConfiguredGithubHost = 'https://github.com'
}
$initialState | ConvertTo-Json -Depth 10 | Set-Content $statePath -Encoding utf8NoBOM

(Get-Content $statePath -Raw | ConvertFrom-Json).lastConfiguredGithubHost
# → https://github.com
```

- [ ] **Step 2: Refactor the Token deletion into a helper, and implement Auth**

Replace the entire `switch ($Reset) { … }` block from Task 2 with:

```powershell
$ResetSentinelHost = 'https://prism-reset-stub.invalid'

function Remove-TokenCacheFiles {
    param([string]$DataDir)
    $tokenPath = Join-Path $DataDir 'PRism.tokens.cache'
    $previousPath = "$tokenPath.previous"
    Write-Host "  removing $tokenPath" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $previousPath -Force -ErrorAction SilentlyContinue
}

function Write-Utf8NoBom {
    # Cross-version replacement for `Set-Content -Encoding utf8NoBOM` (PS 7+ only).
    # [System.Text.UTF8Encoding]::new($false) → no BOM. Works in PS 5.1 (.NET
    # Framework 4.x) and PS 7+ (.NET 5+) identically.
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Set-LastConfiguredGithubHostToSentinel {
    param([string]$DataDir, [string]$Sentinel)
    $statePath = Join-Path $DataDir 'state.json'

    if (-not (Test-Path -LiteralPath $statePath)) {
        # No state.json yet → write a fresh v1 default shape with the sentinel
        # host. Mirrors AppState.Default in PRism.Core/State/AppState.cs,
        # serialized via the host's KebabCaseJsonNamingPolicy.
        Write-Host "  state.json missing — writing v1 default with sentinel host" -ForegroundColor DarkGray
        New-Item -ItemType Directory -Force $DataDir | Out-Null
        $fresh = [ordered]@{
            version = 1
            reviewSessions = @{}
            aiState = [ordered]@{ repoCloneMap = @{}; workspaceMtimeAtLastEnumeration = $null }
            lastConfiguredGithubHost = $Sentinel
        }
        Write-Utf8NoBom -Path $statePath -Text ($fresh | ConvertTo-Json -Depth 10)
        return
    }

    Write-Host "  setting state.json.lastConfiguredGithubHost = $Sentinel" -ForegroundColor DarkGray

    $raw = Get-Content -LiteralPath $statePath -Raw
    try {
        $obj = $raw | ConvertFrom-Json
    } catch {
        throw "state.json at $statePath is not valid JSON; refusing to overwrite. Repair the file by hand or use '-Reset Full' to wipe local state. Original parse error: $($_.Exception.Message)"
    }

    # Mutate the field. ConvertFrom-Json yields a PSCustomObject; if the
    # property is missing, Add-Member adds it. If present, the assignment
    # overwrites.
    if ($obj.PSObject.Properties.Name -contains 'lastConfiguredGithubHost') {
        $obj.lastConfiguredGithubHost = $Sentinel
    } else {
        $obj | Add-Member -NotePropertyName 'lastConfiguredGithubHost' -NotePropertyValue $Sentinel
    }

    Write-Utf8NoBom -Path $statePath -Text ($obj | ConvertTo-Json -Depth 10)
}

switch ($Reset) {
    'Token' {
        Remove-TokenCacheFiles -DataDir $dataDir
    }
    'Auth' {
        Set-LastConfiguredGithubHostToSentinel -DataDir $dataDir -Sentinel $ResetSentinelHost
    }
    'Full' { throw "Reset(Full) not implemented yet — see Task 4." }
}
```

- [ ] **Step 3: Verify Auth-mode field surgery — token preserved, host set to sentinel**

```powershell
.\run.ps1 -Reset Auth                              # Ctrl+C once npm ci starts

Test-Path $tokenPath                               # → True   (token preserved!)
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$state.lastConfiguredGithubHost                    # → https://prism-reset-stub.invalid
$state.reviewSessions.'octocat/hello/1'.pendingReviewId
# → PRR_kwAB123  (preserved)
```

- [ ] **Step 4: Verify malformed-JSON abort path**

```powershell
'{ this is not valid JSON' | Set-Content $statePath -Encoding utf8NoBOM
.\run.ps1 -Reset Auth
# Expected: PowerShell prints the throw message ("state.json at …
# is not valid JSON; refusing to overwrite. …") and exits non-zero.

(Get-Content $statePath -Raw)                      # → unchanged malformed JSON
Test-Path $tokenPath                               # → True (Auth mode never touches the token)
```

- [ ] **Step 5: Verify missing-state.json creates a v1 default with sentinel**

```powershell
Remove-Item $statePath -ErrorAction SilentlyContinue
.\run.ps1 -Reset Auth                              # Ctrl+C once npm ci starts
# Expected: prints "state.json missing — writing v1 default with sentinel host"
Test-Path $statePath                               # → True (created)
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$state.version                                     # → 1
$state.lastConfiguredGithubHost                    # → https://prism-reset-stub.invalid
$state.reviewSessions                              # → empty PSCustomObject
$state.aiState.repoCloneMap                        # → empty PSCustomObject
```

- [ ] **Step 6: Verify idempotency — re-running Auth preserves the sentinel**

```powershell
.\run.ps1 -Reset Auth                              # Ctrl+C once npm ci starts
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$state.lastConfiguredGithubHost                    # → https://prism-reset-stub.invalid (unchanged)
```

- [ ] **Step 7: Commit**

```powershell
git add run.ps1
git commit -m "$(@'
feat(run.ps1): implement -Reset Auth (host-change-modal trigger)

Auth mode sets state.json.lastConfiguredGithubHost to the sentinel
"https://prism-reset-stub.invalid" so the next launch's /api/auth/state
probe reports a host mismatch and the frontend surfaces the
host-change-resolution modal. Token cache is intentionally untouched —
deleting it would route the user to /setup and shadow the modal.

If state.json is missing, a fresh v1 default (mirroring AppState.Default)
is written with the sentinel host. If state.json exists but is malformed,
the script aborts with a clear error rather than overwriting it.

Refs docs/superpowers/specs/2026-05-06-run-script-reset-design.md § 4
'@)"
```

---

### Task 4: Implement `-Reset Full` mode

**Files:**
- Modify: `run.ps1`

**Goal:** `-Reset Full` recursively wipes `<dataDir>`. Missing directory is a no-op.

- [ ] **Step 1: Set up known-good populated dataDir**

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
New-Item -ItemType Directory -Force $dataDir | Out-Null
'token' | Set-Content (Join-Path $dataDir 'PRism.tokens.cache') -NoNewline
'{}' | Set-Content (Join-Path $dataDir 'state.json')
'{}' | Set-Content (Join-Path $dataDir 'config.json')
'lock' | Set-Content (Join-Path $dataDir 'state.json.lock') -NoNewline

(Get-ChildItem $dataDir).Count   # → 4
```

- [ ] **Step 2: Implement `Full` mode**

Replace the `'Full' { throw … }` arm of the switch with:

```powershell
    'Full' {
        if (Test-Path -LiteralPath $dataDir) {
            Write-Host "  removing recursively: $dataDir" -ForegroundColor DarkGray
            Remove-Item -LiteralPath $dataDir -Recurse -Force
        } else {
            Write-Host "  $dataDir not present — skip" -ForegroundColor DarkGray
        }
    }
```

- [ ] **Step 3: Verify the full wipe**

```powershell
.\run.ps1 -Reset Full                       # Ctrl+C once npm ci starts
Test-Path $dataDir                          # → False
```

- [ ] **Step 4: Verify missing-directory no-op**

```powershell
.\run.ps1 -Reset Full                       # Ctrl+C once npm ci starts
# Expected: prints "$dataDir not present — skip" and proceeds. No error.
```

- [ ] **Step 5: Commit**

```powershell
git add run.ps1
git commit -m "$(@'
feat(run.ps1): implement -Reset Full (recursive dataDir wipe)

Full mode removes <dataDir> recursively for true first-launch testing.
Missing directory is a silent no-op. Loses draft bodies — the spec
calls draft text "sacred", so this mode is dev-only by design and
never surfaces in product UI.

Refs docs/superpowers/specs/2026-05-06-run-script-reset-design.md § 4
'@)"
```

---

### Task 5: End-to-end smoke verification (full pipeline runs)

**Files:**
- None (verification only).

**Goal:** Run the spec's § 8 smoke checklist against the implemented script. This is the only task that lets `dotnet run` complete; earlier tasks Ctrl+C'd before npm to keep iteration fast.

For each smoke item, populate the starting state (using the snippet from "Smoke-testing convention" at the top of this plan), run the indicated invocation, let it boot fully, and verify the observable behavior. Press `Ctrl+C` to stop the host between checks.

- [ ] **Step 1: Default invocation regression (spec § 8 item 1)**

```powershell
# Starting state: realistic dataDir (token + state with non-null host).
.\run.ps1
```

Verify in browser:
- App opens at `http://localhost:51xx`.
- Inbox loads (no Setup screen) — the existing token still works.
- After `Ctrl+C`: cache file unchanged, state.json unchanged.

- [ ] **Step 2: `Token` mode happy path (spec § 8 item 2)**

```powershell
.\run.ps1 -Reset Token
```

Verify in browser:
- App opens.
- Routes to `/setup` (token gone → `hasToken: false` from `/api/auth/state`).
- After `Ctrl+C`: state.json byte-identical to before (the file was not touched in this mode).

- [ ] **Step 3: `Token` mode idempotency (spec § 8 item 3)**

```powershell
# After step 2, the token is already gone. Run again:
.\run.ps1 -Reset Token
```

Verify:
- Status line prints, no errors, no non-zero exit during the reset phase.
- App boots normally to `/setup`.

- [ ] **Step 4: `Auth` mode triggers host-change-resolution modal (spec § 8 item 4)**

```powershell
# Starting state: token present, state.json populated with
# lastConfiguredGithubHost = 'https://github.com'. Leave config.json alone —
# the sentinel ('https://prism-reset-stub.invalid') is guaranteed to differ
# from any real config.github.host, so no config edits are required.
.\run.ps1 -Reset Auth
```

Verify in browser:
- The host-change-resolution modal appears immediately on app load. Old host should display as `https://prism-reset-stub.invalid`; new host as the current `config.github.host`.
- Click **Continue**. Verify the modal closes, `state.json.lastConfiguredGithubHost` is now the current `config.github.host`, and the inbox loads (token still works, no Setup re-entry needed).
- `Ctrl+C` to stop the host. Re-run `.\run.ps1 -Reset Auth` and this time click **Revert** in the modal. Verify the app exits (per `AuthEndpoints.MapAuth`'s `/api/auth/host-change-resolution` handler in the `revert` branch).

After both flows are verified, the host-change-resolution UX has been smoke-tested end-to-end via the dev script — exactly the affordance this spec exists for.

- [ ] **Step 5: `Auth` mode malformed-JSON abort (spec § 8 item 5)**

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
'{ this is not valid JSON' | Set-Content (Join-Path $dataDir 'state.json') -Encoding utf8NoBOM
'placeholder-token' | Set-Content (Join-Path $dataDir 'PRism.tokens.cache') -NoNewline
.\run.ps1 -Reset Auth
```

Verify:
- Script aborts non-zero before `npm ci`.
- Error message names the file path and quotes the parse error.
- `state.json` content is unchanged from the truncated input (the script did not overwrite it).
- Token cache file is **unchanged** (Auth mode never touches the token).

- [ ] **Step 6: `Full` mode true first-launch (spec § 8 item 6)**

```powershell
.\run.ps1 -Reset Full
```

Verify in browser:
- App opens.
- Routes to `/setup` (no token, no state, no config).
- After `Ctrl+C`: `<dataDir>` exists again (the host recreated it on launch) and contains a fresh `state.json` with the v1 default shape.

- [ ] **Step 7: Pass-through args (spec § 8 item 7)**

```powershell
.\run.ps1 -Reset Token --no-browser
```

Verify:
- Reset banner prints.
- `npm ci` + `npm run build` run.
- `dotnet run` starts and **does not open a browser** (the `--no-browser` flag flowed through `$DotnetArgs`).
- `Ctrl+C` to stop.

- [ ] **Step 8: Bad mode value (spec § 8 item 8)**

```powershell
.\run.ps1 -Reset Garbage
```

Verify:
- PowerShell parameter binding error fires *before* any reset banner or `npm ci` invocation.
- Exit code is non-zero.

- [ ] **Step 9: Restore the developer's actual session**

```powershell
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
# Identify the most recent backup directory created by Task 2 step 1
$latestBackup = Get-ChildItem (Split-Path $dataDir) -Filter 'PRism.bak.*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestBackup) {
    if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir }
    Copy-Item -Recurse $latestBackup.FullName $dataDir
    Write-Host "Restored from $($latestBackup.FullName)"
}
```

After confirming the developer's PRism session works end-to-end again, the backup may be removed.

- [ ] **Step 10: No commit — this task is verification only.**

If any check fails, return to the relevant earlier task. Otherwise proceed to Task 6.

---

### Task 6: Final read-through and PR-ready cleanup

**Files:**
- Modify (only if issues found): `run.ps1`, `docs/superpowers/specs/2026-05-06-run-script-reset-design.md`

**Goal:** Sanity-check the final state of `run.ps1` against the spec acceptance criteria, fix any drift, and stage the branch for `pr-autopilot`.

- [ ] **Step 1: Read `run.ps1` end-to-end**

Open `run.ps1`. Verify:
- Top-of-file comment block lists the four modes, says default is `None`, and includes the macOS / Linux Keychain caveat for `Token` mode (per spec § 9 last bullet).
- `param()` declares `[ValidateSet('None','Token','Auth','Full')] [string]$Reset = 'None'` and `[Parameter(ValueFromRemainingArguments)] [string[]]$DotnetArgs`.
- `$ErrorActionPreference = 'Stop'` is preserved.
- `$dataDir` resolution matches `DataDirectoryResolver.Resolve()` exactly.
- Reset dispatch runs *before* `Push-Location $PSScriptRoot`.
- `dotnet run --project PRism.Web @DotnetArgs` is the final invocation — `@args` is no longer referenced.

- [ ] **Step 2: Spot-check spec acceptance**

Re-read spec § 9 acceptance criteria. For each bullet, point at the line(s) of `run.ps1` that satisfy it. If any bullet has no implementation, return to the relevant earlier task.

- [ ] **Step 3: If any drift was found, commit the cleanup**

```powershell
git add run.ps1
git commit -m "chore(run.ps1): align with spec acceptance criteria"
```

- [ ] **Step 4: Branch is ready for `pr-autopilot`**

Confirm:
- `git log --oneline main..HEAD` shows 4–5 commits (Tasks 1–4, plus optional cleanup).
- `git diff main..HEAD --stat` lists `run.ps1`, `docs/roadmap.md`, and `docs/superpowers/specs/2026-05-06-run-script-reset-design.md` (and possibly `docs/superpowers/plans/2026-05-06-run-script-reset.md`) — nothing else.
- `git status` reports a clean working tree.
