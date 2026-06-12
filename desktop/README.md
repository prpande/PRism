# PRism Desktop (Electron shell)

The Electron shell that wraps the PRism web app as a desktop application. It spawns the
ASP.NET **sidecar** (`PRism.Web`) as a child process and loads the SPA the sidecar serves.

## 🚀 Run it from a clone

One command builds everything from source and launches the app **detached** — the terminal is
freed once the build finishes and the window appears, with no extra console window left behind.

```powershell
# Windows — runs from the built-in Windows PowerShell (5.1); PowerShell 7 is not required
scripts\run-desktop.ps1                 # build + launch
scripts\run-desktop.ps1 -SkipBuild      # skip the build, launch the current build
scripts\run-desktop.ps1 -Clean          # wipe local state, then build + launch
```

```bash
# macOS
./scripts/run-desktop.sh                # build + launch
./scripts/run-desktop.sh --skip-build   # skip the build, launch the current build
./scripts/run-desktop.sh --clean        # wipe local state, then build + launch
```

- **No flags** — builds the SPA, publishes the sidecar, builds the Electron shell, then launches.
- **`-SkipBuild` / `--skip-build`** — skips the build and launches the current `desktop/.dev-sidecar/` output. Use for fast re-launches once a build is current.
- **`-Clean` / `--clean`** — resets to a fresh first-run before launching (see below). Combinable with the skip-build flag.

## 🧰 Prerequisites

- **Node.js + npm** — CI builds on Node 24 (the recommended version).
- **.NET 10 SDK** — the solution targets `net10.0`.
- The launcher runs a **preflight** and prints exact install commands if either is missing — it builds nothing until the toolchain is satisfied.

## 🧹 Start fresh (`-Clean` / `--clean`)

Wipes PRism's local state **before** launching, for a true first-run experience.

- 🗑️ Removes the entire data dir — drafts, view state, and logs.
- 🔑 Signs you out: clears your GitHub token, so the next launch opens at the **Setup** screen.
  - **Windows** — the token lives in the data dir, so the wipe removes it.
  - **macOS** — the token lives in the Keychain, so the launcher also clears that item (`service=PRism`, `account=github-pat`).
- 🛡️ A safety guard refuses to delete anything that isn't your PRism data dir.
- 🚫 Refused while the app is running — close the window first.
- ⚠️ You'll re-paste your Personal Access Token on the next launch.

## 👀 What to expect

- **Success** — the window appears. The launcher does not health-gate the sidecar; the window is your signal.
- **If the sidecar fails to start** — Electron raises a native **"PRism failed to start"** dialog (even on a detached launch).
- **Logs** — `run-desktop.log` in your PRism data dir captures Electron's stdout, including the `[startup]` timing line. (Backend stderr is piped through Electron and is not in this log.)
- **Stop** — close the window. Electron owns the sidecar, so it shuts down too.
- **Single instance** — launching again while the app is up just refocuses the existing window; nothing is rebuilt.

## 🍎 macOS Gatekeeper

- An npm-fetched Electron usually runs without a prompt.
- If macOS blocks it on first run, right-click the app and choose **Open**, or clear the quarantine flag once:
  ```bash
  xattr -dr com.apple.quarantine desktop/node_modules/electron
  ```

## 🛠️ Manual launch (fallback)

If the scripts misbehave, run the same steps by hand from the repo root. This launches in the
**foreground** (the app stops when you close the terminal or press `Ctrl+C`), which is useful for
debugging. Steps 1–3 are the build; the `-SkipBuild` / `--skip-build` flag corresponds to step 4 alone.

**Windows (PowerShell):**

```powershell
# 1. Build the SPA (served by the sidecar)
cd frontend; npm ci; npm run build; cd ..

# 2. Publish the ASP.NET sidecar into desktop\.dev-sidecar
dotnet publish PRism.Web\PRism.Web.csproj -c Release -r win-x64 --self-contained false -o desktop\.dev-sidecar

# 3. Build the Electron main process
cd desktop; npm ci; npm run build

# 4. Launch Electron, pointing it at the published sidecar (run from desktop\)
$env:PRISM_SIDECAR_BINARY = "$PWD\.dev-sidecar\PRism.Web.exe"
node_modules\.bin\electron.cmd .
```

**macOS (bash / zsh):**

```bash
# 1. Build the SPA (served by the sidecar)
( cd frontend && npm ci && npm run build )

# 2. Publish the ASP.NET sidecar into desktop/.dev-sidecar
#    Apple Silicon -> osx-arm64; Intel -> osx-x64
dotnet publish PRism.Web/PRism.Web.csproj -c Release -r osx-arm64 --self-contained false -o desktop/.dev-sidecar

# 3. Build the Electron main process
( cd desktop && npm ci && npm run build )

# 4. Launch Electron, pointing it at the published sidecar (run from desktop/)
cd desktop
export PRISM_SIDECAR_BINARY="$PWD/.dev-sidecar/PRism.Web"
./node_modules/.bin/electron .
```

**Clean state by hand** (the manual equivalent of `-Clean` / `--clean`):

```powershell
# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\PRism"
```

```bash
# macOS
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/PRism"
security delete-generic-password -s PRism -a github-pat
```

## ⚙️ How the launch works (maintainers)

- **Preflight** — verify Node/npm presence and .NET SDK major ≥ 10, else print remediation and exit.
- **Build** — frontend SPA → `PRism.Web/wwwroot`; framework-dependent host-RID `dotnet publish` into a freshly-cleared `desktop/.dev-sidecar/` (separate from the packaging `desktop/sidecar/` dir); Electron `tsc`.
- **Detach** — a generated wrapper sets `PRISM_SIDECAR_BINARY`, `cd`s to `desktop/`, and redirects output to the log.
  - **Windows** — spawned via the `Win32_Process.Create` (WMI) pattern, using the same PowerShell host that launched the script, with the wrapper's console window hidden.
  - **macOS** — spawned via `nohup … & disown`.
