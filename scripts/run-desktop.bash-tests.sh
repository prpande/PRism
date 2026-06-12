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
assert_rc() {  # msg expected_rc cmd args...
  local msg="$1" exp="$2"; shift 2
  local rc=0; "$@" >/dev/null 2>&1 || rc=1
  if [[ "$rc" -eq "$exp" ]]; then echo "  PASS: $msg"; else echo "  FAIL: $msg (expected rc=$exp, got rc=$rc)"; fails=$((fails + 1)); fi
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

# resolve_args (position-independent flag parse + unknown-flag rejection)
assert_eq "skip=0 clean=0" "$(resolve_args)"                       "no args -> skip=0 clean=0"
assert_eq "skip=1 clean=0" "$(resolve_args --skip-build)"         "--skip-build -> skip=1"
assert_eq "skip=0 clean=1" "$(resolve_args --clean)"              "--clean -> clean=1"
assert_eq "skip=1 clean=1" "$(resolve_args --clean --skip-build)" "both flags (order-independent) -> skip=1 clean=1"
assert_eq "error:--bogus"  "$(resolve_args --bogus)"              "unknown flag -> error"

# data_dir_cleanable (defense-in-depth guard for --clean's rm -rf)
assert_rc "real ~/.local/share/PRism -> safe"       0 data_dir_cleanable "$HOME/.local/share/PRism"
assert_rc "deep absolute PRism path -> safe"        0 data_dir_cleanable "/Users/me/.local/share/PRism"
assert_rc "empty path -> unsafe"                    1 data_dir_cleanable ""
assert_rc "relative path -> unsafe"                 1 data_dir_cleanable "relative/PRism"
assert_rc "non-PRism leaf -> unsafe"                1 data_dir_cleanable "/Users/me/.local/share/Foo"
assert_rc "too-shallow (one segment) -> unsafe"     1 data_dir_cleanable "/PRism"
assert_rc "\$HOME itself -> unsafe"                 1 data_dir_cleanable "$HOME"

# pid_is_live (single-instance liveness check; format gate guards kill -0 0 / -1)
assert_rc "live current PID (\$\$) -> live"          0 pid_is_live "$$"
assert_rc "empty pid -> not live"                   1 pid_is_live ""
assert_rc "pid 0 -> not live (kill -0 0 hits group)" 1 pid_is_live "0"
assert_rc "negative pid -> not live (kill -0 -1)"   1 pid_is_live "-1"
assert_rc "non-numeric pid -> not live"             1 pid_is_live "abc"

# remediation text
assert_match "$(node_remediation 2>&1)"   "brew install node" "node remediation names brew"
assert_match "$(dotnet_remediation 2>&1)" "\.NET 10"          "dotnet remediation references .NET 10"

if [[ "$fails" -gt 0 ]]; then echo "$fails test(s) failed"; exit 1; fi
echo "All tests passed"
