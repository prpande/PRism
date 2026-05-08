---
title: "Latent CI failure masked by fail-fast ordering — pre-push checklist asymmetric with CI"
date: 2026-05-08
category: workflow-patterns
module: ci
problem_type: workflow_pattern
component: tooling
symptoms:
  - "CI red on `build-and-test` for multiple consecutive pushes, all failing at the same early step (e.g. `Frontend lint`)"
  - "After fixing the early failure, the next push surfaces a *different* failure in a later step (e.g. `Playwright tests`) that has actually been broken for several commits"
  - "Local pre-push checklist (`npm run lint && npm run build && npx vitest run`) all green but CI red on a step the checklist doesn't run (`dotnet test`, `npx playwright test`)"
  - "An e2e assertion against a placeholder UI string still passes locally and in vitest unit tests, but Playwright catches the mismatch — and only when the earlier CI gates pass"
root_cause: process_gap
resolution_type: process_change
severity: medium
tags: [ci, github-actions, playwright, vitest, fail-fast, pre-push, workflow]
---

# Latent CI failure masked by fail-fast ordering — pre-push checklist asymmetric with CI

## Problem

PR #25 (S3 PR6 — frontend PR-detail shell) accumulated **8 commits** before the agent realized that one Playwright e2e test in `frontend/e2e/inbox.spec.ts` had been broken since commit `d46695a` (`feat(s3-pr6): PrDetailPage + nested route binding (lights up)`). That commit replaced the temporary `S3StubPrPage` with the real `PrDetailPage` but did not update the e2e test, which still asserted on the placeholder heading `PR detail lands in S3`.

The regression sat invisible through three CI runs because each run failed at an **earlier** step:

```
CI step order (.github/workflows/ci.yml):
  1. Frontend install     (npm ci)
  2. Frontend lint        (eslint + prettier --check)   ← three pushes in a row failed here
  3. Frontend build       (tsc -b && vite build)
  4. Frontend unit tests  (vitest)
  5. Restore (.NET)
  6. Build (.NET)
  7. Test (.NET)
  8. Playwright install
  9. Playwright tests     ← the latent regression
```

GitHub Actions is fail-fast by default — when step N exits non-zero, steps N+1...M never run. The Playwright failure was real and reproducible from `d46695a` onward, but every push between then and 2026-05-08 either failed lint (prettier on `events.ts`) or wasn't pushed. The first push that fixed lint exposed the latent Playwright regression.

The local pre-push checklist documented in CLAUDE.md and used by the agent was a **strict subset** of CI:

| Step | Local pre-push | CI |
|------|---------------|-----|
| Frontend lint | yes | yes |
| Frontend build | yes | yes |
| Frontend unit tests (vitest) | yes (touched files) | yes (full suite) |
| Backend `dotnet test` | no | yes |
| Frontend e2e (`npx playwright test`) | no | yes |

So anything CI-only could regress silently and only surface when an earlier CI gate started passing. This is a structural blind spot, not a one-off oversight.

## Symptoms

1. CI status `build-and-test` red for several consecutive pushes, each failing at the same early step (lint / build / unit tests).
2. After the early step is fixed, the *next* push surfaces a different failure in a later step that has actually been broken for multiple commits.
3. Local `npm run lint && npm run build && npx vitest run` all green; CI fails on `npx playwright test`.
4. The Playwright failure references a UI element / heading / route that was renamed or replaced in an earlier commit on the same branch.
5. Negative assertions in e2e (`expect(...).not.toBeVisible()`) referencing strings that no longer exist in the codebase — these are tautological and pass even when the *intent* of the test has been silently invalidated.

## Root cause

Two compounding gaps:

1. **CI fail-fast ordering is correct, but creates a masking regime.** When step N is broken for commit C, the regression in step N+1 introduced at commit C-k (k commits earlier) is invisible until step N is fixed. Reordering CI to run slow gates first is *not* the right answer — fail-fast is the right ergonomic for the common case where each push has one unrelated failure. The fix has to live on the local pre-push side.

2. **Pre-push checklist asymmetric with CI.** The standing pre-push instructions in this repo's CLAUDE.md and in agent prompts named only the fast / cheap gates (lint, build, vitest). Anything in CI but not in the checklist (dotnet test, Playwright) was running effectively only on push, with the masking regime above hiding regressions across multiple pushes.

The negative-assertion tautology in `inbox.spec.ts:245` (`not.toBeVisible(/PR detail lands in S3/i)` — a string that no longer exists in the codebase) is a related smell: a test whose *intent* (no navigation occurred) was correct, but whose *assertion* (named-element absent) became permanently true the moment the named element was deleted. URL-pinning (`expect(page).toHaveURL(/\/$/)`) is the better shape — it has actual semantic content tied to the test's intent.

## Resolution

Three changes, applied in PR #25:

1. **Codify a pre-push checklist in `README.md` § Development workflow.** Mirrors `.github/workflows/ci.yml` step-for-step, including `npx playwright test`. Spells out *when* Playwright is required (touching `frontend/src/pages/`, `App.tsx`, route bindings, UI surfaces referenced by `frontend/e2e/`, or response shapes the SPA reads). Anyone running through it pre-push hits the same failure modes CI would.

2. **Fix the stale negative assertion.** `inbox.spec.ts:245` now asserts `expect(page).toHaveURL(/\/$/)` instead of `not.toBeVisible(/PR detail lands in S3/i)`. URL-pinning has actual semantic content tied to the test's "no navigation occurred" intent.

3. **This solutions entry** — institutional memory so the next person who hits a similar masking pattern finds the recipe instead of re-discovering it.

## What was *not* done (and why)

- **Reorder CI to run Playwright first.** Fail-fast is correct ergonomics; reordering optimizes for a different (and rarer) failure mode at meaningful cost to the common case.
- **Add `continue-on-error: true` to every CI step.** Inflates CI time on every push for a one-shot signal that's better solved at the local level.
- **Add a Husky pre-push hook.** Contradicts this project's documented pattern. The S3 deferrals doc records `[Skip] CI-driven automation for deferrals tracking` — the team explicitly chose human-discipline-via-CLAUDE.md over CI/tooling enforcement for cross-cutting workflow rules. Adding a hook for one rule starts a parallel-mechanism trend the project rejected.

## Verification

After PR #25 merges:

- `README.md § Development workflow → Pre-push checklist` documents the canonical list.
- `frontend/e2e/inbox.spec.ts` no longer references `S3StubPrPage` or the `PR detail lands in S3` heading anywhere.
- Future agents and contributors running the README's pre-push checklist will catch any regression in any CI gate before pushing, removing the asymmetry.

If a similar masking pattern surfaces again — a CI step has been red for the same reason for >2 consecutive pushes, and fixing it exposes a new failure — the response is *not* "fix the new failure quickly and move on" but "scan the local pre-push checklist for the gap that allowed the latent regression, and update the checklist before merging." The masking regime itself is the bug; the specific test is just the symptom.

## Related

- `.github/workflows/ci.yml` — the CI definition that ordered fast checks before slow ones.
- `docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md` § `[Skip] CI-driven automation for deferrals tracking` — establishes the project's preference for human-discipline-via-CLAUDE.md.
- `docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md` — prior incident where Playwright was the only signal (dev-mode tests passed against Vite while the single-binary path was broken). Same lesson: don't trust unit tests alone for surface-level integration.
