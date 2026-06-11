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
