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

```powershell
# From your worktree root:
./run.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 --no-browser
```

- The port is honored: `run.ps1` passes `--no-launch-profile` so
  `launchSettings.json`'s `applicationUrl` (pinned to 5180) no longer overrides
  `-Port`, and restores `ASPNETCORE_ENVIRONMENT=Development` (so the SPA bundle
  still serves — Production via `dotnet run` would serve an empty bundle).
- Confirm it bound where you asked: the console prints
  `PRism listening on http://localhost:5200 (dataDir: …\PRism-wt-0)`.
- Two such instances with distinct `(port, dataDir)` run concurrently with no
  lockfile contention.
- Defaults are unchanged: bare `./run.ps1 --no-browser` is still
  `5180` + `%LocalApplicationData%\PRism` + Development, exactly as before.

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

If you only need the app (not a pinned port), omit `--urls` is **not** exposed by
`run.ps1` (it always sets `-Port`, default 5180). True auto-port for `run.ps1` —
letting the app self-select from 5180–5199 — is a deferred enhancement (the issue's
Approach A). For now, assign an explicit `5200 + N` per the table above.
