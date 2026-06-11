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

# remediation text
assert_match "$(node_remediation 2>&1)"   "brew install node" "node remediation names brew"
assert_match "$(dotnet_remediation 2>&1)" "\.NET 10"          "dotnet remediation references .NET 10"

if [[ "$fails" -gt 0 ]]; then echo "$fails test(s) failed"; exit 1; fi
echo "All tests passed"
