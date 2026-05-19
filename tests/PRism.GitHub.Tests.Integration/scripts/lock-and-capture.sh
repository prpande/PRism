#!/usr/bin/env bash
# tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh
#
# Atomic lock-then-capture for a corpus PR on prpande/PRism. Spec § 9.5.
# Cross-platform parity for the PowerShell form; same behaviour.
#
# Usage: ./lock-and-capture.sh PR_NUMBER OUTPUT_DIR

set -euo pipefail

PR_NUMBER="${1:?usage: $0 PR_NUMBER OUTPUT_DIR}"
OUTPUT_DIR="${2:?usage: $0 PR_NUMBER OUTPUT_DIR}"

mkdir -p "$OUTPUT_DIR"

# Idempotency — see PowerShell variant for rationale.
# Use `gh api --jq` (gh's embedded jq engine) instead of piping to external jq — gh ships its
# own jq, which means the script has zero external dependencies beyond gh itself.
LOCKED=$(gh api "repos/prpande/PRism/issues/$PR_NUMBER" --jq '.locked')
if [ "$LOCKED" = "true" ]; then
    echo "[lock] PR #$PR_NUMBER already locked — skipping PUT (idempotent)."
else
    echo "[lock] Locking conversation on PR #$PR_NUMBER ..."
    if ! gh api -X PUT "repos/prpande/PRism/issues/$PR_NUMBER/lock" --silent; then
        echo "[error] gh api lock failed for PR #$PR_NUMBER. To roll back any PRs locked earlier in the sequence, run: gh api -X DELETE repos/prpande/PRism/issues/{N}/lock for each affected PR (see the 'Unlocking a test PR' section in docs/contract-tests.md)." >&2
        exit 1
    fi
fi

echo "[capture] Fetching commits + files + mergedAt + baseRefOid for PR #$PR_NUMBER ..."
gh pr view "$PR_NUMBER" --repo prpande/PRism --json commits,files,mergedAt,baseRefOid > "$OUTPUT_DIR/pr$PR_NUMBER.pr.json"

echo "[capture] Fetching review comments for PR #$PR_NUMBER ..."
gh api "repos/prpande/PRism/pulls/$PR_NUMBER/comments" > "$OUTPUT_DIR/pr$PR_NUMBER.comments.json"

echo "[done] PR #$PR_NUMBER captured to $OUTPUT_DIR"
