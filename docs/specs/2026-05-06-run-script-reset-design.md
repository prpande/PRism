# `run.ps1` reset modes: Design

**Slice**: dev-tooling, out-of-band — not a roadmap slice. Small change to `run.ps1` for testing scenarios that depend on persisted local state.
**Date**: 2026-05-06.
**Status**: Implemented (PR #8).
**Source authorities**: [`run.ps1`](../../../run.ps1) is the production code; [`PRism.Core/Auth/TokenStore.cs`](../../../PRism.Core/Auth/TokenStore.cs), [`PRism.Core/State/AppState.cs`](../../../PRism.Core/State/AppState.cs), [`PRism.Core/Json/JsonSerializerOptionsFactory.cs`](../../../PRism.Core/Json/JsonSerializerOptionsFactory.cs), and [`PRism.Core/Hosting/DataDirectoryResolver.cs`](../../../PRism.Core/Hosting/DataDirectoryResolver.cs) are the on-disk shape this design mirrors.

---

## 1. Goal

Add a `-Reset <mode>` parameter to `run.ps1` so the developer can launch PRism with one of three pre-cleaned local-state shapes:

- **Token only** — re-test the Setup → connect flow against a fresh token without losing inbox unread state, drafts, or `lastConfiguredGithubHost`.
- **Host-change-modal trigger** — keep the token, set `state.json.lastConfiguredGithubHost` to a sentinel value (`https://prism-reset-stub.invalid`) guaranteed to differ from any real `config.github.host`. On next launch, `AuthEndpoints.MapAuth`'s `/api/auth/state` handler reports a host mismatch (since `LastConfiguredGithubHost is not null && != current host`), the frontend renders the host-change-resolution modal, and the developer can exercise the Continue / Revert paths without hand-editing `state.json` or `config.json`.
- **Full wipe** — re-test the genuine first-launch experience (no `state.json`, no `config.json`, no token, no lockfile).

Default invocation (`.\run.ps1`) is unchanged in every observable way — same npm build, same `dotnet run`, same exit semantics. Existing pass-through args (`--no-browser`, etc.) continue to flow through to `dotnet run`.

The deferred work — a real in-app "Replace token" footer link that lets a *user* (not a developer) rotate PATs or sign out — is tracked in [`docs/roadmap.md`](../../roadmap.md) under S6 and pointed at by the existing PoC spec ([`spec/03-poc-features.md`](../../spec/03-poc-features.md) § Settings, [`claude-design-prompt.md`](../../claude-design-prompt.md) § "PoC scope"). This design intentionally does **not** touch the C# host, the auth endpoints, or the frontend — only `run.ps1`.

## 2. Scope

### In scope

- A `-Reset` parameter on `run.ps1` with `[ValidateSet('None','Token','Auth','Full')]`, defaulting to `'None'`.
- Resolving the data directory the same way the host does (`Environment.GetFolderPath('LocalApplicationData')` → joined with `'PRism'`), so this script never drifts from `DataDirectoryResolver.Resolve()`.
- Three reset operations against `<dataDir>`, executed *before* `npm ci` / `npm run build` / `dotnet run`.
- A single short status line printed when a reset fires, identifying the mode and the absolute path being modified, so the developer can visually confirm which mode actually executed without inspecting the filesystem.
- One Pester-style smoke test (manual checklist documented at the bottom of this spec) covering each mode against a freshly-populated dataDir. No automated test infrastructure is added — the script is dev-only and the existing test suites in `tests/` cover the C# behaviors that the modes exercise.
- A short comment block at the top of `run.ps1` explaining the parameter, the modes, and the macOS keychain caveat.

### Out of scope

- Any C# code change. `TokenStore.ClearAsync()`, `IViewerLoginProvider.Set("")`, and an in-app disconnect endpoint are all parts of the deferred S6 "Replace token" feature, not this dev affordance.
- Any frontend change. The Setup-screen re-entry experience belongs to S6.
- Cross-platform correctness on macOS for `-Reset Token`. On macOS the PAT lives in the Keychain (via `WithMacKeyChain` in `TokenStore`), not in the cache file — deleting the file does not clear the secret. Documented as a comment in `run.ps1`; the deferred in-app feature reuses `TokenStore.ClearAsync()` which goes through the MSAL helper and is cross-platform-correct.
- Confirmation prompts. The flag itself is the consent. Adding `-Confirm` would create a paste-once-then-walk-away anti-pattern for the developer running the script.
- A separate "Reset" cmdlet, a separate `reset.ps1`, or any other indirection. One file changes: `run.ps1`.

## 3. Parameter shape

```powershell
.\run.ps1                            # default: -Reset None, no reset
.\run.ps1 -Reset Token               # mode A
.\run.ps1 -Reset Auth                # mode B
.\run.ps1 -Reset Full                # mode C
.\run.ps1 -Reset Token --no-browser  # pass-through args still flow to dotnet run
```

`[ValidateSet('None','Token','Auth','Full')]` is chosen for two reasons:

- PowerShell tab-completion offers the four values, so the developer never types a typo.
- Mutual exclusivity is enforced by construction. Three boolean switches (`-ResetToken` / `-ResetAuth` / `-ResetFull`) would let `.\run.ps1 -ResetToken -ResetFull` parse silently into "what wins?" — a subtle bug class that `ValidateSet` rules out at parse time.

## 4. Mode behavior

| Mode | What it removes | What survives | Notes |
|---|---|---|---|
| `None` | nothing | everything | Default. Identical to `.\run.ps1` invocations today. |
| `Token` | `<dataDir>\PRism.tokens.cache` (and any `.previous` companion left by MSAL Extensions during a torn write) | `state.json` (drafts, `pendingReviewId`/`threadId`/`replyCommentId`, last-viewed shas, `lastConfiguredGithubHost`), `config.json`, log files, lockfile | Forces the Setup screen on next launch. The `lastConfiguredGithubHost` survives, so no host-change modal fires. |
| `Auth` | Sets `state.json.lastConfiguredGithubHost` to the literal sentinel `https://prism-reset-stub.invalid`. **Does not** touch the token cache. All other JSON values in `state.json` are preserved unchanged (whitespace and indentation may reformat — the host does not depend on file formatting, only on the JSON contents). | Token cache, drafts, pendingReviewIds, every other field of `state.json`. | The token survives so that the `/api/auth/state` probe runs with `hasToken: true` on next launch; the sentinel host is guaranteed to differ from any real `config.github.host` so the handler reports `hostMismatch: { old: "https://prism-reset-stub.invalid", new: <current> }` and the frontend renders the host-change-resolution modal. The developer then exercises Continue / Revert. To return to a clean state for the next test, run `-Reset Auth` again (idempotent — the sentinel overwrite is the same regardless of the previous value). |
| `Full` | The entire `<dataDir>` tree, recursively | nothing | True first-launch reset. Loses draft bodies — the spec calls draft text "sacred", so this mode is dev-only by design and never surfaces in product. |

### Mode-specific edge cases

**`Token` mode.**

- If `<dataDir>\PRism.tokens.cache` does not exist, the operation is a no-op (idempotent).
- The MSAL Extensions library writes a sibling `.previous` file briefly during a save; if it is present at script-launch time, remove it as well so a subsequent run does not pick up stale bytes.
- On macOS / Linux the file deletion is cosmetic — see § 2 "Out of scope" for the cross-platform caveat.

**`Auth` mode.**

- The token cache is **not** touched. The whole point of `Auth` mode is to surface the host-change modal, which requires `hasToken: true` on the next launch (otherwise `/setup` shadows the modal).
- If `<dataDir>\state.json` does not exist, create it with the v1 default shape but `last-configured-github-host = "https://prism-reset-stub.invalid"`. Default shape: `{ "version": 1, "review-sessions": {}, "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null }, "last-configured-github-host": "https://prism-reset-stub.invalid" }`. **Property names on disk are kebab-case**, matching the host's `JsonSerializerOptionsFactory.Storage` configuration ([`PRism.Core/Json/JsonSerializerOptionsFactory.cs`](../../../PRism.Core/Json/JsonSerializerOptionsFactory.cs)) which uses `KebabCaseJsonNamingPolicy` with `PropertyNameCaseInsensitive = false`. CamelCase or PascalCase keys would silently fail to bind during the host's `JsonSerializer.Deserialize<AppState>(...)` call, leaving `LastConfiguredGithubHost` as `null` and defeating the entire purpose of `Auth` mode. This shape matches `AppState.Default` from [`PRism.Core/State/AppState.cs`](../../../PRism.Core/State/AppState.cs) with the sentinel substituted in.
- If `<dataDir>\state.json` exists but cannot be parsed as JSON, abort with a clear error rather than overwriting it with a regenerated body. The user's draft state is more valuable than convenience; corrupted-state recovery is a separate concern (the C# host has its own `state.json.corrupt-<timestamp>` recovery path documented in [`spec/03-poc-features.md`](../../spec/03-poc-features.md), and it should be the one to invoke that path, not this script).
- If `<dataDir>\state.json` is parseable, set `lastConfiguredGithubHost` to the sentinel string `https://prism-reset-stub.invalid` and write the result back to `<dataDir>\state.json` as UTF-8 without BOM. The round-trip uses PowerShell's `ConvertFrom-Json` / `ConvertTo-Json -Depth 10`; this preserves all string and number values verbatim (existing kebab-case enum strings on disk round-trip as strings, no enum conversion happens) but **may reformat whitespace and indentation**. The host does not depend on `state.json` formatting, only on its JSON contents, so this is harmless. The write uses `[System.IO.File]::WriteAllText($statePath, $json, [System.Text.UTF8Encoding]::new($false))` — the explicit `UTF8Encoding($false)` constructor disables the BOM. This API works identically in PowerShell 5.1 (.NET Framework 4.x) and PowerShell 7+ (.NET 5+), so the script remains compatible with both. Power-loss safety is not pursued: a corrupted half-written `state.json` falls through to the host's existing `state.json.corrupt-<timestamp>` recovery path documented in [`spec/03-poc-features.md`](../../spec/03-poc-features.md). For a dev-only script, that recovery path is the safety net.

**`Full` mode.**

- If `<dataDir>` does not exist, no-op.
- `Remove-Item -Recurse -Force` against the resolved path. The script never recurses outside `<dataDir>`; the path is constructed from `Environment.GetFolderPath('LocalApplicationData')` and a literal `'PRism'` segment, so no caller-controlled string can redirect it.

## 5. Order of operations

```
1. Parse -Reset parameter (PowerShell does this; ValidateSet errors here if invalid)
2. Resolve $dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'
3. If -Reset is not 'None':
   a. Print one-line status: "Reset(<mode>): <action> at <path>"
   b. Execute the mode-specific cleanup (see § 4)
4. Push-Location $PSScriptRoot
5. Push-Location frontend; npm ci; npm run build; Pop-Location
6. dotnet run --project PRism.Web @args
7. Pop-Location
```

Reset runs in step 3, *before* the npm build and the `dotnet run`. Two reasons:

- `dotnet run` opens the lockfile (`<dataDir>\state.json.lock`) and on Windows holds `state.json` open via the polling loop. Trying to delete those files from outside the running process is a `IOException: file in use` race. Deleting them while the host is not running is a clean filesystem operation.
- The npm build is multi-second; the developer expects "did the reset fire?" feedback as the first thing on screen, not after a 30-second build.

## 6. Error handling

- `Token` mode: missing files are silent (`-ErrorAction SilentlyContinue`). No file present = goal already achieved.
- `Auth` mode: missing `state.json` is silent. Malformed `state.json` aborts the script with a non-zero exit code and a message pointing at the file path; the developer chooses whether to repair, copy aside, or use `-Reset Full` instead.
- `Full` mode: missing `<dataDir>` is silent. A `Remove-Item -Recurse` failure (e.g., a sibling file held open by Explorer) aborts the script with the original error and a non-zero exit.
- The script's existing `$ErrorActionPreference = 'Stop'` is preserved; only the deletion calls relax to `SilentlyContinue` for the missing-file case.

## 7. Cross-platform behavior

| Platform | `Token` | `Auth` | `Full` |
|---|---|---|---|
| Windows | Correct — DPAPI-encrypted file at `<dataDir>\PRism.tokens.cache` is the only persistence | Correct — single `state.json` field mutation; token untouched | Correct — `<dataDir>` is the only place PRism writes |
| macOS | **Cosmetic only** — secret lives in Keychain (`com.prism.tokens` / `github-pat`), not the file | Correct — `state.json` is the same on macOS; `Auth` mode does not touch the token, so the keychain caveat doesn't apply | **Partial** — `<dataDir>` is wiped, but the Keychain entry persists since it lives outside `<dataDir>`. Next launch will see the keychain bytes via `MsalCacheHelper.LoadUnencryptedTokenCache` and report `hasToken: true`, *not* the true "first-launch with no token" state. To force a true first-launch on macOS, additionally delete the keychain entry by hand: `security delete-generic-password -s PRism -a github-pat` (or use Keychain Access.app). |
| Linux | **Cosmetic only** — secret lives in libsecret schema `com.prism.tokens` | Correct — same reasoning as macOS | **Partial** — same caveat as macOS. To force a true first-launch on Linux, delete the libsecret entry by hand: `secret-tool clear Service PRism Account github-pat`. |

The macOS / Linux gap on `Token` is the price of doing this in PowerShell rather than in-app. The deferred S6 work uses `TokenStore.ClearAsync()`, which routes through the MSAL helper and clears the keychain entry on every platform. A note at the top of `run.ps1` flags this for any non-Windows developer running the script.

## 8. Testing

This is a dev-only script with three small modes. The project has no PowerShell test infrastructure (Pester is not installed; CI runs `dotnet test` and the npm/vitest/playwright suites). Adding Pester to the toolchain for one script is over-investment. The verification approach:

### Manual smoke checklist (run once at implementation time, re-run if `run.ps1` changes)

1. **Default invocation regression.** With a populated `<dataDir>`, run `.\run.ps1`. Verify `<dataDir>\PRism.tokens.cache`, `<dataDir>\state.json`, and `<dataDir>\config.json` are all unchanged after launch. The app should connect with the existing token and load the inbox without going through Setup.
2. **`Token` mode happy path.** Same starting state. Run `.\run.ps1 -Reset Token`. Verify the cache file is gone, `state.json` is byte-identical to before (the script does not touch `state.json` in this mode), and the app routes to `/setup` because `hasToken: false`.
3. **`Token` mode idempotency.** Run `.\run.ps1 -Reset Token` against a `<dataDir>` that already has no token. Should print the status line, no errors, and proceed normally.
4. **`Auth` mode triggers the host-change modal.** With a populated `<dataDir>` (token present, `state.json.lastConfiguredGithubHost: "https://github.com"`, non-empty `reviewSessions`), run `.\run.ps1 -Reset Auth`. Verify the token cache is **unchanged** (still present), `state.json.lastConfiguredGithubHost` is now `"https://prism-reset-stub.invalid"`, and `reviewSessions` parses to the same object shape as before (compare `ConvertFrom-Json` output, not raw bytes — formatting may differ). Then let the script run end-to-end and confirm in the browser that the host-change-resolution modal renders on app load.
5. **`Auth` mode malformed-JSON abort.** Truncate `state.json` to a half-written JSON. Run `.\run.ps1 -Reset Auth`. Verify the script aborts with a non-zero exit, prints a clear error, the token cache is **unchanged**, and `state.json` is NOT overwritten.
6. **`Full` mode true first-launch.** Populate `<dataDir>` with all artifacts (token, state, config, lock). Run `.\run.ps1 -Reset Full`. Verify the directory is empty (or absent) after the reset line prints, and the app's first-launch path runs (token cache regenerated, `state.json` regenerated with defaults, Setup screen shown).
7. **Pass-through args.** Run `.\run.ps1 -Reset Token --no-browser`. Verify the `--no-browser` flag reaches `dotnet run` (no browser opens).
8. **Bad mode value.** Run `.\run.ps1 -Reset Garbage`. Verify PowerShell rejects the invocation at parse time before any side effects (no token deletion, no `dotnet` invocation).

### Why no automated test

The script's logic is on the order of 30 lines. Pester would add a dependency, a CI step, and a test file longer than the script itself. The C# behaviors the modes exercise (Setup re-entry, host-change modal, fresh-launch state hydration) are already covered by `tests/PRism.Core.Tests`, `tests/PRism.Web.Tests`, and the frontend vitest/playwright suites. The script is glue around those; the manual checklist above is the right level of investment.

## 9. Acceptance criteria

- `.\run.ps1` (no args) runs identically to today: same console output ordering, same `npm ci` + `npm run build` + `dotnet run --project PRism.Web` invocations, same exit code on success and failure.
- `.\run.ps1 -Reset Token` removes only `<dataDir>\PRism.tokens.cache` (and any `.previous` companion) before the npm/dotnet pipeline runs. The app's Setup screen is reachable on next launch.
- `.\run.ps1 -Reset Auth` does **not** touch the token cache; it sets `state.json.last-configured-github-host = "https://prism-reset-stub.invalid"` (kebab-case key, matching the host's storage serializer) so the next launch's `/api/auth/state` probe reports a host mismatch and surfaces the host-change-resolution modal. All other JSON values in `state.json` are preserved unchanged (formatting may reformat). If `state.json` is missing, it is created with the v1 default shape (`AppState.Default`) plus the sentinel host. If `state.json` exists but is malformed (parse error, empty file, JSON null root, or non-object root), the script aborts with a clear error and does not overwrite it.
- `.\run.ps1 -Reset Full` removes the entire `<dataDir>` tree (when present), letting the host repopulate from defaults at startup.
- A status line is printed before each reset, identifying the mode and the absolute path being modified.
- Each mode is idempotent — running the same mode twice in a row produces the same end state on the second run, with no errors.
- A typoed mode (`-Reset Token2`) is rejected at PowerShell parameter binding before any filesystem action runs.
- Pass-through args (e.g., `--no-browser`) still reach `dotnet run` after a reset.
- Top-of-file comment block on `run.ps1` lists the modes, the cross-platform caveat for `Token` on macOS / Linux, and a one-line pointer to this spec for the rationale.

## 10. Deferred work — in-app "Replace token" feature

Tracked in [`docs/roadmap.md`](../../roadmap.md) under S6. The PoC spec already calls for it ([`spec/03-poc-features.md`](../../spec/03-poc-features.md) § Settings, the *only* auth-management UI in PoC). When that slice is brainstormed, the open design questions are:

- **Identity-change semantics for `state.json`.** When the user disconnects and reconnects with a different login, `pendingReviewId` / `threadId` / `replyCommentId` belong to the previous viewer and will 401-or-orphan against the new one. The same-login case (PAT rotation, scope change) wants full preservation. Recommendation when that brainstorm runs: detect viewer change by comparing `result.Login` post-reconnect to the previous cached login; if different, clear `pendingReviewId` / `threadId` / `replyCommentId` (preserve draft bodies — text is sacred). Mirrors the host-change rule in [`spec/02-architecture.md`](../../spec/02-architecture.md) and `AuthEndpoints.MapAuth`'s `/api/auth/host-change-resolution` handler.
- **Mid-flight calls.** What happens to in-flight inbox polls, SSE channels, and (post-S5) submit-pipeline mutations when disconnect fires? The spec's "PAT rotation mid-pipeline" recovery in [`spec/02-architecture.md`](../../spec/02-architecture.md) is the right precedent — re-auth via modal, resume from the same step, drafts and `pendingReviewId` preserved.
- **Endpoint shape.** Likely `POST /api/auth/disconnect` returning `{ ok: true }`; calls `TokenStore.ClearAsync()`, `viewerLogin.Set("")`, and (per the identity-change rule) optionally clears the per-PR pending IDs in `state.json` after the next `/api/auth/connect` succeeds with a different login.

This dev-tooling design exists to make those scenarios testable today, before the S6 work happens.
