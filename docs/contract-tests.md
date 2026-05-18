# Contract tests — live-GitHub integration suite

## What this suite is for

`PRism.GitHub.Tests.Integration` exercises `GitHubReviewService` against five locked, SHA-pinned PRs in `prpande/PRism`. It catches parsing/derivation drift on the read path (PR detail, diff, comments, timeline) and GraphQL shape drift on the queries PRism issues. The suite is opt-in — `workflow_dispatch` only in CI, manual `dotnet test --filter "Category=Integration&Canonical!=Strict"` locally. Design rationale and architecture: see `docs/specs/2026-05-18-frozen-pr-contract-tests-design.md`.

## Prereqs

- **Local (recommended):** a fine-grained PAT scoped to `prpande/PRism` only with `metadata:read + pull_requests:read`, exported as `PRISM_INTEGRATION_PAT` in your shell profile. Smallest blast radius if the token leaks. Note: fine-grained PATs do not return scopes in the `X-OAuth-Scopes` header; the fitness-smoke test 7e accepts this by design.
- **Local (fallback):** `gh auth login --scopes "repo,read:org"` — the test suite uses `gh auth token`. The `repo` scope grants full read/write to every private repo your account can reach; the principle-of-least-privilege concern is real but acceptable for one-off runs.
- **CI:** `PRISM_INTEGRATION_PAT` secret (owner-managed), set with a 90-day expiry, calendar reminder for both PAT rotation AND a 30-day workflow_dispatch poke.

## Running locally

```powershell
dotnet test --filter "Category=Integration&Canonical!=Strict"
```

Run from repo root. The `.runsettings` filter ensures the default `dotnet test` (without `--filter`) excludes the integration suite.

Validation tests against `prpande/ShaktimaanAI` PRs run under the same `Category=Integration` filter (they carry both `Integration` and `Validation` traits); to run only the validation subset, use `--filter "Category=Validation"`.

## Test PR corpus

| PR | Shape category | Why it tests |
|---|---|---|
| #1 | Single-iteration baseline | 2 commits 2 seconds apart. **Current expectation: `Ok` + exactly 1 iteration.** Post-calibration, `DetermineQuality` short-circuits to `Low` only on 0 commits, so a 2-commit PR flows through clustering and resolves to one cluster — two adjacent commits introducing two related YAML files is genuinely "one unit of work." Pins the canonical baseline against future `DetermineQuality` regressions. (Spec § 4 originally documented a `Low` short-circuit expectation; the runbook's "Algorithm calibration baseline" section below records why that historical framing was wrong.) |
| #16 | Rebased-history `committedDate` collision | 9 commits with identical `committedDate` after rebase. Algorithm graceful-degradation when primary time signal is collapsed. |
| #19 | Multi-burst with review-fix tail | 12 commits over ~1h36m in 2-3 natural bursts. Default boundary detection + comment-anchor subset. |
| #22 | Overnight time-gap boundary | 9-commit evening session + 1 next-morning fix. Time-gap boundary signal. |
| #28 | Tight intra-cluster + late package-lock fix | 7 commits in 19 min + 4-hour gap to package-lock. Short-gap suppression early-return path of `ForcePushMultiplier`. |

## Algorithm calibration baseline (2026-05-18)

The `IterationClusteringCoefficients` defaults were calibrated against this corpus + an 8-PR cross-author validation set (`prpande/ShaktimaanAI`, exercised by `ShaktimaanAiValidationTests`). The current baseline:

| Coefficient | Default | Calibration role |
|---|---|---|
| `HardFloorSeconds` | 60 | Resolution floor for human-scale gaps (1-3 min fixes don't get swept into the degenerate bucket) |
| `DegenerateFloorFraction` | 0.6 | Tolerates rebase-collapsed PRs (PR #16 sits at 0.56) while still catching truly-degenerate timelines |
| `MadK` | 4 | Widens MAD threshold so tight-burst PRs don't have intra-burst variation treated as iteration boundaries |
| `MinimumBoundaryGapSeconds` | 900 | Floors the MAD threshold — codifies "real iteration boundaries are at least one context-switch apart" (15 min) |

**MAD=0 fallback** (in `MadThresholdComputer`): when MAD is degenerate (rebase-collapsed input), threshold becomes the second-largest distance. Only true single-outlier gaps register as boundaries — prevents the legacy `median + 1` fallback from over-segmenting rebase-collapsed PRs.

**Single-commit semantics** (in `PrDetailLoader.DetermineQuality`): single-commit PRs return `Ok + 1 iteration`, not `Low + null`. Doc-fix and revert PRs are legitimately "one unit of work."

**When a coefficient retune is needed:** if a future tuning shifts the canonical iteration counts (the `CanonicalIterationCountTests`'s `Pr16Canonical`/`Pr19Canonical` constants), the ShaktimaanAi validation set is the witness against over-fitting to PRism's commit shape. A change that improves PRism corpus but regresses ShaktimaanAi is overfitting and should be reconsidered.

## Adding a new test PR

> **PAT scope note.** The routine test runs above use a read-only PAT (`metadata:read + pull_requests:read`). Corpus expansion needs WRITE access on the issues subresource for the `gh api -X PUT .../lock` call — the script will fail with HTTP 403 against a read-only PAT. Re-authenticate `gh` with elevated scope (or use a separate fine-grained PAT with `issues:write` on `prpande/PRism`) for the duration of this workflow, then revoke or downgrade afterwards.

1. **Pick on shape criteria** — commit count, time gaps, `authoredDate` vs `committedDate` divergence. Do **not** run the algorithm first.
2. **Run the atomic lock-and-capture script.**

   PowerShell:
   ```powershell
   cd tests/PRism.GitHub.Tests.Integration/scripts
   .\lock-and-capture.ps1 -PrNumber <N> -OutputDir ../captured/
   ```

   bash:
   ```bash
   cd tests/PRism.GitHub.Tests.Integration/scripts
   ./lock-and-capture.sh <N> ../captured/
   ```

   Locking happens first; capture immediately after — this is one script invocation by design to prevent comment drift between lock and capture.
3. **Add a new static field** to `FrozenPrCorpus.cs` with the captured `HeadSha`, `MergedAt`, `ExpectedFiles`, `ExpectedCommentAnchors`, and the shape category.
4. **Append the new entry** to `FrozenPrCorpus.All()`.
5. **Document the shape category** in this runbook's corpus table.

## Refreshing the GraphQL fixture

When an intentional GitHub GraphQL schema change lands, refresh `Fixtures/pr19-graphql-response.json`:

- **PowerShell:** `$env:PRISM_FROZEN_PR_CAPTURE_FIXTURE='1'; dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"; Remove-Item env:PRISM_FROZEN_PR_CAPTURE_FIXTURE`
- **bash:** `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"`

Capture mode runs only locally — the CI workflow blocks it with a two-layer guard (spec § 7). The capture flow strips freeform-text and identity fields against `FixtureStripAllowlist`; review the resulting fixture diff in the PR.

**Trap: do NOT export `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1` in your shell profile** (`.bashrc`, `$PROFILE`, `.zshrc`, etc.) for convenience. The capture branch logs a banner and passes silently, so a leaked env var means every routine `dotnet test --filter "Category=Integration&Canonical!=Strict"` rewrites the fixture with the current live API response. The test always reports green because expected == actual == now, and real shape drift is silently captured into the baseline instead of detected. Always use the inline `$env:X=...; ...; Remove-Item env:X` (or `unset`) idiom shown above so the variable's lifetime is scoped to the one capture command.

## Triaging a shape-drift failure

When `Frozen_pr_graphql_shape_unchanged` fails, the test output contains a structural diff: `+ /path (kind)`, `- /path`, `~ /path (kindA → kindB)`. Read the diff, check the GitHub changelog, decide intentional-update-vs-real-break.

### Iteration-count failures (tests 7a, 7h)

Decision rule:

- **Q1:** Does the new count match a defensible hand-labeled boundary count for the PR's shape, derived without looking at the algorithm output? If **no**, the algorithm change is a regression — revisit the coefficient change. One thing to check: if the gap-of-interest sits below `MinimumBoundaryGapSeconds=900` (15 min), the algorithm correctly treats it as intra-iteration noise, not a boundary — that is not a regression.
- **Q2:** If yes, does the PR's shape category still hold? If **yes**, update the expected count in `FrozenPrCorpus` with a PR comment explaining the new canonical value. If **no**, retire the PR from the corpus and pick a replacement on the same shape criteria.

### Range assertions on PRs #16 / #19

Range assertions absorb both tuning moves AND regressions within the range. The sibling strict-canonical tests in `CanonicalIterationCountTests.cs` (run via `dotnet test --filter "Canonical=Strict"`) assert the captured canonical value — when the range test passes but `Canonical=Strict` fails, apply Q1/Q2 above.

## Unlocking a test PR

If anyone needs to re-comment on a locked corpus PR:

```bash
gh api -X DELETE /repos/prpande/PRism/issues/{N}/lock
```

After the comment, re-lock with `gh api -X PUT` (or the lock-and-capture script with the existing PR number; it's idempotent on already-captured PRs because the script does not write to a different output file).

## PAT expiry recovery

When `PRISM_INTEGRATION_PAT` expires (after the 90-day reminder is missed), all corpus tests fail with HTTP 401.

- **Diagnosis:** check the secret's expiry date in repo Settings → Secrets and variables → Actions.
- **Recovery:** create a new fine-grained PAT with the same scope (`prpande/PRism`, `metadata:read + pull_requests:read`, new 90-day expiry, calendar reminder reset) and update the `PRISM_INTEGRATION_PAT` secret value.
- **Verify:** re-trigger `workflow_dispatch` and confirm the suite returns to green.
