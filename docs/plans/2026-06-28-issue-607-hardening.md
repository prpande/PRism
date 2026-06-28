# Issue #607 — Core / desktop / CI hardening

Date: 2026-06-28
Branch: `fix/607-core-desktop-ci-hardening`
Scope guard: only `PRism.Core`, `desktop/`, `.github/workflows/` touched (per #607; `PRism.Web` /
`PRism.GitHub` / `frontend/` are owned by #603/#605).

## A — corrupt-state quarantine collides + escapes the recovery catch (Major)

File: `PRism.Core/State/AppStateStore.cs`

**Bug.** Inside `catch (JsonException)` the quarantine name used 1-second wall-clock resolution
(`yyyyMMddHHmmss`) and `File.Move(_path, quarantine, overwrite: false)`. Two corrupt loads in the
same second produced the same target → `File.Move` threw `IOException`, which is NOT caught by
`catch (JsonException)` → escaped `LoadAsync` raw, so the corrupt file was never
quarantined/replaced and self-heal never happened. A `SaveCoreAsync` failure inside the catch
(disk full / permissions) escaped the same way.

**Fix.** Extracted `QuarantineAndResetAsync`:
1. Collision-proof quarantine name: `yyyyMMddHHmmssfff` + `Guid.NewGuid():N` (millisecond + Guid),
   not 1-second resolution. The `state.json.corrupt-` prefix is preserved (existing glob/tests
   still match).
2. Best-effort layering that cannot propagate: move-aside is wrapped; on
   `IOException`/`UnauthorizedAccessException` it falls back to `File.Delete`; if that also fails it
   swallows (the resave's atomic rename overwrites `_path` anyway). The resave itself is wrapped so a
   disk-full/permission failure returns `AppState.Default` in memory instead of throwing.
   `OperationCanceledException` is intentionally NOT swallowed — cancellation propagates.

**Test (TDD).** `AppStateStoreTests.LoadAsync_self_heals_two_corrupt_loads_in_the_same_second_without_throwing`
loads two corrupt `state.json` files back-to-back (same wall-clock second). Old code: second
`File.Move` throws on the colliding name → test fails. New code: both self-heal, two distinct
`state.json.corrupt-*` files exist, both loads return version 7. Full `PRism.Core.Tests` suite green
(890 passed, 1 skipped).

## B — long-lived sidecar child has no 'error' listener after startup (Minor)

File: `desktop/src/sidecar.ts`

**Bug.** `readPortFromStdout`'s `cleanup()` removes the transient `error`/`exit` listeners once the
port is parsed. After a successful start the returned child has only a stderr-drain listener — no
`error` listener. A `ChildProcess` that emits `error` with no listener re-throws it as an uncaught
exception → Electron main-process crash, bypassing the graceful before-quit `stop()`.

**Fix.** Added exported `attachPostStartupListeners(child)`, called from `startSidecar` after the
health check passes. It attaches a persistent `error` handler (logs + `void stopChild(child)` for
graceful teardown instead of throwing) and an `exit` logger.

**Test (TDD).** `sidecar-lifecycle.unit.test.ts.attachPostStartupListeners absorbs a post-startup
'error' ...` — a fake child with the listener attached: `emit('error', …)` does NOT throw
(`assert.doesNotThrow`) and triggers `stopChild` → `SIGTERM`. Without the listener the emit would
re-throw. Desktop `tsc` build clean; `test:unit` 45/45 pass; `npm run lint` clean.

## C — CI installs Claude CLI via unpinned `curl | bash` (FORK) — FIXED

File: `.github/workflows/claude.yml`

**Investigation.**
- (a) Versioned URL + published checksum: `claude.ai/install.sh` 302-redirects to
  `downloads.claude.ai/claude-code-releases/bootstrap.sh`, a moving "stable" endpoint with no
  immutable versioned URL and no Anthropic-published checksum for the *script*. The script's own
  `TARGET` version arg is ignored by its download logic (it always fetches `…/latest`), so the CLI
  *version* is not pinnable through it. However, the script DOES verify the downloaded binary's
  SHA256 against a per-release `manifest.json` before running it — so binary integrity is already
  covered; the only unpinned link is the bootstrap script itself.
- (b) Official pinned install Action: none exists separate from `anthropics/claude-code-action`,
  which already installs the CLI. The `curl | bash` step is only a temporary workaround for upstream
  regression anthropics/claude-code-action#1254 ("drop once resolved").

**Chosen remediation (feasible + robust): vendored-hash pin.** Replaced the pipe-to-bash with
download → `sha256sum -c` verify against a pinned hash → execute. This converts "run whatever bytes
are served" into "run exactly the reviewed script; fail-closed on any change," and combined with the
script's own per-release binary checksum gives end-to-end integrity on a runner that the next step
hands `CLAUDE_CODE_OAUTH_TOKEN`. Pinned `CLAUDE_INSTALLER_SHA256 =
005ec1a937f32dfbb74f9e810287bcb12cba2d5cae4c9277aa8c6364adbf1787` (computed 2026-06-28). Also
switched to `set -euo pipefail` and `$RUNNER_TEMP`.

**Residual (documented inline, not a regression):** the bootstrap always installs the LATEST CLI
(upstream limitation); each binary is still manifest-checksum-verified. If Anthropic updates the
bootstrap script the step fails closed until a maintainer re-reviews and re-pins — intended for a
token-bearing step. The whole step should be dropped once #1254 is fixed.

**Disposition: FIXED** (closing commit).

## D — @claude workflow runs for any commenter; no author-association gate (Minor)

File: `.github/workflows/claude.yml`

**Bug.** The job `if:` only checked `contains(body, '@claude')`. On a public repo any commenter
could summon the agent and have their comment body become the agent's prompt (prompt injection).

**Fix.** Added an author-association membership gate to both branches:
`contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)`
for `issue_comment` and the `github.event.issue.author_association` equivalent for `issues`.
Verified: the file parses as valid YAML and the expression uses valid Actions builtins
(`fromJSON`, `contains(array, value)`, the `author_association` payload field).

## Verification summary

- `dotnet test PRism.Core.Tests` — 890 passed, 1 skipped, 0 failed (real `dotnet.exe`).
- desktop `npm run build` (tsc) — clean; `npm run test:unit` — 45/45 pass; `npm run lint` — clean.
- `claude.yml` — parses as YAML; expressions valid.
