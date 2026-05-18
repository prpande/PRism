# tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1
#
# Atomic lock-then-capture for a corpus PR on prpande/PRism. Spec § 9.5.
# Locks the PR conversation FIRST so no new comments can land between lock and capture,
# then immediately captures head SHA + files + comment anchors + merge timestamp.
#
# Usage: ./lock-and-capture.ps1 -PrNumber 19 -OutputDir ../captured/
#
# Pre-req: `gh auth status` returns OK. The PAT used by `gh` must have push (or admin) on
# prpande/PRism — locking requires write access on the issues subresource.

param(
    [Parameter(Mandatory=$true)][int]$PrNumber,
    [Parameter(Mandatory=$true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }

# Idempotency: if the PR is already locked, skip the PUT call (saves an API request and
# keeps the script re-runnable on partial-failure recovery). Spec § 9.8 — unlock is by
# explicit DELETE; we never auto-unlock here.
$prMeta = (& gh api "repos/prpande/PRism/issues/$PrNumber") | ConvertFrom-Json
if ($prMeta.locked) {
    Write-Host "[lock] PR #$PrNumber already locked — skipping PUT (idempotent)."
} else {
    Write-Host "[lock] Locking conversation on PR #$PrNumber ..."
    & gh api -X PUT "repos/prpande/PRism/issues/$PrNumber/lock" --silent
    if ($LASTEXITCODE -ne 0) { throw "gh api lock failed for PR #$PrNumber (exit $LASTEXITCODE). To roll back any PRs locked earlier in the sequence, run: gh api -X DELETE repos/prpande/PRism/issues/{N}/lock for each affected PR (see docs/contract-tests.md § 8)." }
}

Write-Host "[capture] Fetching commits + files + mergedAt + baseRefOid for PR #$PrNumber ..."
$prJson = & gh pr view $PrNumber --repo prpande/PRism --json commits,files,mergedAt,baseRefOid
if ($LASTEXITCODE -ne 0) { throw "gh pr view failed for PR #$PrNumber (exit $LASTEXITCODE)" }
Set-Content -Path (Join-Path $OutputDir "pr$PrNumber.pr.json") -Value $prJson

Write-Host "[capture] Fetching review comments for PR #$PrNumber ..."
$commentsJson = & gh api "repos/prpande/PRism/pulls/$PrNumber/comments"
if ($LASTEXITCODE -ne 0) { throw "gh api comments failed for PR #$PrNumber (exit $LASTEXITCODE)" }
Set-Content -Path (Join-Path $OutputDir "pr$PrNumber.comments.json") -Value $commentsJson

Write-Host "[done] PR #$PrNumber captured to $OutputDir"
