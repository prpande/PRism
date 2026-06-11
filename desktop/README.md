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
