# Testing in parallel without collisions

How an agent runs the PRism app — and its Playwright suites — **solo, without
stepping on another agent's running session**. Multiple agents (or worktrees, or a
human + an agent) on one machine otherwise collide on two shared resources: the
**HTTP port** and the **data store** (`state.json`, token cache, logs, lockfile).
This guide gives each session a private `(port, dataDir)` pair so everyone can
build, launch, and test at the same time.

The app itself is already parallelism-ready: with `--urls` it binds the port you
ask for; without it, it auto-selects a free port from **5180–5199**
(`PortSelector`) and prints it; `--dataDir` gives it a private store; and a
per-store lockfile (`LockfileManager`) enforces one instance per store. The
orchestration wrappers (`run.ps1`, the Playwright configs) are what this guide
parameterizes.

## The one rule

**One worktree per agent, each with a private `(port, dataDir)`.**

A git worktree is mandatory anyway (see the global worktree rule), and it is also
what gives each agent a **private `frontend/` build and `PRism.Web/wwwroot`** — two
`run.ps1` from the *same* checkout would clobber each other's build output. So:
never run two sessions from the same checkout; give each its own worktree.

## Worktree `node_modules` (junction hazards)

A worktree's `frontend/node_modules` is often a junction into the primary
checkout's, not a real copy. Two hazards follow:

- **Empty target → tests silently can't run.** A fresh worktree that was never
  `npm install`'d (or whose junction target is empty) has no vitest / Playwright /
  `tsc`. Runs appear to "pass" while nothing executed — a common source of
  fabricated "tests green" claims, especially from subagents. Before trusting a
  frontend test result in a worktree, confirm the binary exists
  (`Test-Path frontend/node_modules/vitest/vitest.mjs`) and re-run it yourself; if
  missing, `npm ci` in the **primary** `frontend/` (the junction target).
- **Cleanup can empty the primary's deps.** `git worktree remove --force` can
  follow a live junction and empty the *primary* checkout's `node_modules` — the
  only real copy. Before removing a worktree, confirm the junction is actually
  unlinked (`fsutil reparsepoint query <wt>\frontend\node_modules` errors when the
  reparse point is gone); a populated-target check alone doesn't prove it. The
  always-safe repair if it happens is `npm ci` in the primary `frontend/`.

## Pick your port + dataDir

Assign by worktree index `N = 0, 1, 2, …`:

| Worktree | Port (`-Port` / `PRISM_E2E_PORT`) | dataDir (`-DataDir`) |
|----------|-----------------------------------|----------------------|
| primary checkout | `5180` (default — may omit) | `%LocalApplicationData%\PRism` (default — may omit) |
| worktree 0 | `5200` | `%TEMP%\PRism-wt-0` |
| worktree 1 | `5201` | `%TEMP%\PRism-wt-1` |
| worktree N | `5200 + N` | `%TEMP%\PRism-wt-N` |

**Start the band at 5200, NOT 5180.** Ports **5180–5199** are the app's own
auto-port pool (`PortSelector.DefaultFrom`/`DefaultTo`), and **5181** is reserved
for the real-flow e2e suite (`playwright.real.config.ts`). A pinned port inside
that band collides with an auto-port instance or the real-flow suite. 5200+ clears
both. (Avoid any other port a local service already holds.)

The primary checkout may keep the defaults; **every non-primary worktree must set
both.**

## Launch the app

**Agents launch with `serve-detached.ps1`** — it brings the server up _detached_
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
  C# compile error fails the call _before_ anything detaches (you see the real
  error, not a timeout). Pass `-SkipBuild` only when the build is known current.
- Relaunching the same store while it is healthy is idempotent — it reattaches
  and **warns** that no rebuild occurred (the running server may predate your
  edits; `-Stop` then relaunch to refresh).
- Tear down with `scripts\serve-detached.ps1 -Stop -DataDir $env:TEMP\PRism-wt-0`.
- An occupied port **fails by default** (it is most likely another agent's
  server); pass `-Force` to kill a foreign occupant and take the port.

```powershell
# Human, watching the console (foreground, blocks until Ctrl-C):
./run.ps1 -Reset None -Port 5200 -DataDir $env:TEMP\PRism-wt-0 --no-browser
```

- Pass-through app args (`--no-browser`, or anything after them) flow straight to
  `dotnet run` — `run.ps1` sets `PositionalBinding=$false`, so both
  `./run.ps1 --no-browser` and `./run.ps1 -Reset None --no-browser` work and
  `-Port`/`-DataDir` bind only when named (issue #274). `None` is the no-op reset.
- `run.ps1` passes `--no-launch-profile` (so `-Port` is honored over
  `launchSettings.json`'s 5180) and restores `ASPNETCORE_ENVIRONMENT=Development`
  (so the SPA bundle serves — Production via `dotnet run` would serve an empty
  bundle). It prints `PRism listening on http://localhost:5200 (dataDir: …)`.
- Two instances with distinct `(port, dataDir)` run concurrently with no lockfile
  contention. Defaults are unchanged: `./run.ps1 --no-browser` is still `5180` +
  `%LocalApplicationData%\PRism` + Development.

## Run the frontend Playwright suite

```powershell
cd frontend
$env:PRISM_E2E_PORT = '5200'   # omit to use the default 5180
npx playwright test
```

- `PRISM_E2E_PORT` templates the suite's server `--urls`, the health-check `url`,
  and `baseURL`. The suite's `DataDir` is already a unique per-run temp dir
  (`mkdtempSync`), so you don't set it.
- On a **non-default** port the config disables `reuseExistingServer`, so your run
  always boots its own backend instead of silently attaching to another agent's
  server already on that port. (On the default port, local reuse still applies.)

## Desktop shell

You do **not** assign a `(port, dataDir)` for the desktop e2e — the Electron shell
spawns the sidecar with no `--urls` (it auto-selects a free port and the shell
reads it from stdout), and the e2e harness injects a per-launch temp
`PRISM_DATA_DIR` + `--user-data-dir`. Two desktop **e2e runs** are already
isolated.

Two caveats for **real** (non-e2e) desktop instances:

- **Single-instance lock.** `app.requestSingleInstanceLock()` (keyed on Electron
  userData / app identity, not dataDir) means a second real desktop instance quits
  at the gate — you cannot run two real desktop windows at once on one machine.
- **Shared default store.** A real desktop instance with the default dataDir uses
  `%LocalApplicationData%\PRism` — the same store a default `run.ps1` uses. To run
  a desktop instance alongside a parallel session, give it a private store:
  `$env:PRISM_DATA_DIR = "$env:TEMP\PRism-desktop"` before launching.

## Cleanup & safety

- Reset only **your** store: `./run.ps1 -Reset Token -DataDir $env:TEMP\PRism-wt-0`
  (`Token` clears the token cache; `Full` wipes the whole store). **Never** run
  `-Reset` against the default `%LocalApplicationData%\PRism` — that is the real
  store with the real PAT.
- `run.ps1` guards `-Reset` against catastrophe: it refuses a non-absolute path, a
  protected root (repo, `%USERPROFILE%`, `%LOCALAPPDATA%`, `%TEMP%` itself), a
  too-shallow path, and any directory that looks like a source checkout
  (`.git`/`package.json`/`.sln`). If you see a "Refusing -Reset" error, you pointed
  it somewhere dangerous — point it at your dedicated store.
- **Credentials:** a dataDir under `%TEMP%` accumulates a live token cache
  (`PRism.tokens.cache`). `%TEMP%` is user-private on Windows, but prefer a
  **minimal-scope (read-only) PAT** for test runs, and clear it with
  `-Reset Token -DataDir <your-store>` when finished.

## Zero-config alternative

If you only need the app without a pinned port: note that `--urls` is **not**
exposed by `run.ps1` directly (it always sets `-Port`, default 5180). True
auto-port for `run.ps1` — letting the app self-select from 5180–5199 — is a
deferred enhancement (the issue's Approach A). For now, assign an explicit
`5200 + N` per the table above.
