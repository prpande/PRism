# Manual Validation Suite

A priority-tiered suite of **end-to-end black-box user-journey scenarios** that exercise PRism through its HTTP API + browser surface against a real GitHub sandbox. Walks the wedge user stories the way a real reviewer would, and validates that the experience holds up coherently.

## What this suite IS

- **Black-box end-to-end behavior validation.** Every scenario drives the binary externally — through its served SPA in a real browser and its HTTP API. The suite has no privileged view inside PRism's process and never imports PRism's internal types, helpers, or services.
- **User-journey-shaped.** Each scenario walks a coherent user story start-to-finish: setup → first PR → draft → submit → see the review on GitHub. NOT a 1:1 enumeration of every shipped feature.
- **Fully isolated from the existing test infrastructure.** Lives at repo-root `e2e-validation/`. Has its own `package.json`, `tsconfig.json`, `playwright.config.ts`, `node_modules/`, helpers, fixture setup script, and sandbox repository (`prpande/prism-validation-sandbox`). No imports from `frontend/`, `tests/`, or any other internal tree. The directory could in principle be lifted to a separate repository without dependency changes.
- **Run by a human OR by a Claude Code session.** A human reviewer can walk a scenario by reading its Steps. A Claude Code session can run the corresponding Playwright spec via `npm run validate-experience` (from `e2e-validation/`) and produce a report.
- **Priority-tiered.** Every scenario has a P0/P1/P2/P3 tag so the runner can scope the pass to time available.

## The "no faking" rule (precise definition)

PRism's own internals must not be substituted. Specifically:

1. **PRism's behavior is never faked.** The validation suite never uses `FakeReviewSubmitter`, never sets `PRISM_E2E_FAKE_REVIEW=1`, never calls submit-pipeline behavior hooks (`/test/submit/inject-failure`, `/test/submit/hold`, `/test/submit/seed-pending-review`, `/test/submit/release-hold`). All GraphQL/REST traffic from PRism to GitHub is the real `GitHubReviewService` path against actual GitHub.
2. **GitHub-side state may be pre-shaped via gh CLI as a precondition.** Creating a pending review on the sandbox PR via `gh api`, advancing a head via a forced push, or deleting a comment on github.com is "scenario setup" — PRism still observes the real GitHub server. This is not faking PRism.
3. **Playwright route interception of real GitHub responses is allowed for transient-condition simulation.** The validation suite may intercept and modify GitHub's HTTP responses to simulate network drops, partial responses, or 429s. The real call still leaves PRism's process; only the wire response is manipulated. This is the same model the existing real-flow suite uses via `injectRealFailure`.
4. **Test-env setup endpoints are setup infrastructure, not faking.** PRism's published binary runs `Production` env and exposes no `/test/*` endpoints. The validation suite needs to reset state between scenarios (`/test/clear-pr-session`) and inject real-network failures (`/test/real-inject/inject-failure`). To make these endpoints available, the suite launches PRism with `ASPNETCORE_ENVIRONMENT=Test` but explicitly **without** `PRISM_E2E_FAKE_REVIEW=1`. The setup endpoints are externally-observable HTTP surface (raw `POST` calls from the validation suite); they manipulate test scaffolding, not PRism's GitHub-facing behavior. This is honest setup, not internal faking.

The combination of (1) and (4) is the load-bearing distinction: the validation suite uses the Test-env composition of the same binary the user runs in production. No behavior is substituted; only the scaffolding for fixture reset and real-network-failure injection is enabled.

## What this suite IS NOT

- **Not a replacement for CI tests.** vitest (`frontend/__tests__/`), fake-flow Playwright (`frontend/e2e/*.spec.ts`), real-flow Playwright (`frontend/e2e/real/*.spec.ts`), and dotnet xUnit (`tests/PRism.*.Tests/`) all continue to run as part of the pre-push checklist and CI. They cover algorithmic correctness, internal unit behavior, and fast regression. The validation suite is a peer to those, not a substitute. It lives separately precisely so it doesn't drift into being one.
- **Not a coverage inventory of every shipped feature.** Scenarios are journey-shaped. Many fine-grained behaviors (each row of the reconciliation matrix, each branch of the 401-disambiguation probe, each whitespace-allow-list extension) are covered by CI unit tests; they don't get their own scenarios here.
- **Not for scenarios that are structurally impossible without internal faking.** If reproducing a behavior requires `FakeReviewSubmitter`, `/test/submit/hold`, `/test/emit-pr-updated`, or similar behavior hooks, the scenario is OUT OF SCOPE — listed in [Appendix § Out of scope](#out-of-scope) with the reason. Dropped on this rule: deterministic multi-tab simultaneous submit, deterministic layout-shift-on-banner timing, per-pipeline-step granular failure injection.
- **Not for OS-level UX.** SmartScreen, Gatekeeper, Keychain "Always Allow", screen-reader VoiceOver/NVDA testing — these require platform automation outside Playwright's reach. Out of scope; documented in appendix.

## Black-box isolation contract

The validation suite is designed so it could be lifted to a separate repository without dependency changes. Concretely:

- **No imports** from `frontend/`, `tests/`, `PRism.Web/`, `PRism.Core/`, or any other in-repo tree. TypeScript paths are bounded to `e2e-validation/`.
- **No shared helpers.** If the existing `frontend/e2e/real/helpers/reset-sandbox-fixture.ts` already implements what we need, we re-implement it under `e2e-validation/helpers/` rather than import it. The cost is a few hundred lines of duplication; the benefit is that a refactor in `frontend/e2e/real/` cannot break validation specs invisibly.
- **No shared types.** Even if `SandboxFixture` already exists as a TypeScript type, the validation suite defines its own equivalent. Drift between the two is the explicit acceptable cost of isolation.
- **No shared fixtures.** The validation suite owns `prpande/prism-validation-sandbox` (a separate repo from the existing `prpande/prism-sandbox`). Fixture setup, naming, and reset cadence are entirely the validation suite's.
- **No shared package.json.** `e2e-validation/package.json` carries its own dependencies (Playwright, tsx, types). It does not extend or reference `frontend/package.json`.
- **Communicates with PRism only through its public surface** — the SPA served from `http://localhost:5181`, the HTTP API at `/api/*`, and the Test-env-exposed setup endpoints at `/test/clear-pr-session` and `/test/real-inject/*`. All access is via raw `fetch` / Playwright browser interaction. No FFI, no shared memory, no observation of PRism internals.

The motivation: the validation suite asks "does the experience hold up coherently?" If it shared code with the internal test infrastructure, a refactor of internal helpers could change validation behavior silently — which would couple "the experience works" to "the team's internal helpers happen to keep working a particular way." Isolation breaks that coupling.

## When to run

| Priority pass | What's included | Wall-clock | When |
|---|---|---|---|
| **P0 — Smoke** | 8 scenarios | ~45 min first run; ~30 min once recipes are warm | Before tagging any release. After any PR that touches the demo flow. |
| **P0 + P1 — Standard** | 22 scenarios | ~120 min first run; ~90 min subsequent | Pre-release for substantial changes. After PRs touching submit pipeline, reconciliation, identity, or read-side surfaces. |
| **P0 + P1 + P2 — Comprehensive** | 37 scenarios | ~210 min first run; ~165 min subsequent | Pre-graduation-milestone passes (e.g., before v0.1.0). After major refactors. |
| **All (P0 + P1 + P2 + P3)** | 44 scenarios | ~240 min first run; ~190 min subsequent | Polish passes. Opportunistic. After a long lull in validation runs. |
| **Visual review pack (Part 5)** | 44 V-cases | Variable; depends on Claude pilot results | Polish-focused sessions. Pilot-flagged (validate V-1 first). |

**Time-estimate caveats.** Per-scenario estimates assume the hot path (recipes already done, fixtures already created, no re-runs). Budget +30% for first-time-this-session runs (Recipe A/B/D setup overhead) and +60% if a recipe needs re-running mid-pass. Several scenarios include poll-wait ceilings (~30s for active-PR poll detection in J-P0-05/J-P0-07/J-P2-03/J-P2-04; up to 2 min for inbox poll in J-P1-10/J-P2-13). These waits are inherent to "real polling against real GitHub" — they cannot be shortened without internal faking.

Priority semantics:
- **P0** — wedge-critical. If a P0 scenario fails, the tool's headline value proposition is broken. Do not ship.
- **P1** — important supporting flows. Failure significantly degrades the experience but the wedge still works.
- **P2** — edge cases and secondary surfaces. Failure affects narrower user paths or less-trafficked features.
- **P3** — polish + low-stakes UX. Opportunistic; failure is annoying but doesn't block.

## How to read a scenario

Every scenario in Parts 1–4 uses this shape:

```
## J-PN-MM. <name>
**Priority:** P0 | P1 | P2 | P3
**Wall-clock estimate:** ~N min
**Pre-conditions:** <pre-conditions in 1-3 lines; references Recipe A/B/C/D/E as needed>
**User-actor:** single tester (primary account) | two-account | two-machine
**Steps:** 1) ... 2) ... 3) ...
**Expected (per step or overall):** <observable outcome(s)>
**Failure modes to watch for:** <bulleted list of how this can go wrong subtly>
**Automation:** Playwright `e2e-validation/specs/<spec-name>.spec.ts` (NEW) | manual only (reason)
**Notes:** <optional context>
```

Cases in Part 5 (Visual review pack) use the per-V-case format documented in Part 5's intro.

## Recipes

Several scenarios share pre-conditions. Recipes are named A–E so scenarios can reference them by letter.

**Recipe A — fresh data dir.** Quit any running PRism. The validation suite's launcher chooses a hermetic per-run temp `DataDir`, so the production data dir is normally not touched by validation runs; this recipe is for scenarios that explicitly need a true cold-boot UX:

```
# 1. Stop any running PRism process
# Windows
Stop-Process -Name PRism* -Force -ErrorAction SilentlyContinue
# Give the OS a moment to release file handles before moving the dir.
# A more conservative variant would poll until state.json is no longer
# locked, but Test-Path can't detect locks — only existence — so a short
# sleep is the most reliable cross-version approach.
Start-Sleep -Seconds 1

# 2. Move the data directory aside
Move-Item "$env:LOCALAPPDATA\PRism" "$env:LOCALAPPDATA\PRism.bak.$(Get-Date -f yyyyMMdd-HHmmss)"

# macOS
pkill -f PRism || true
sleep 1
mv "$HOME/Library/Application Support/PRism" "$HOME/Library/Application Support/PRism.bak.$(date +%Y%m%d-%H%M%S)"
```

The token is in the OS keychain — clear it via the Replace-token flow (after Recipe B is done) or via the keychain manager directly if a true cold boot is required.

**Recipe B — fresh PAT (primary login).** Generate at `<host>/settings/personal-access-tokens/new` with the scopes from README.md § "Generate a GitHub Personal Access Token". Save in a password manager so subsequent scenarios can paste it.

**Recipe C — second-login PAT pair (for identity-change scenarios).** J-P1-02, J-P1-04, V-36 need a second GitHub account with a different login. Cheapest path: create a free secondary account (e.g., `prpande-validation`); generate a fine-grained PAT with the same scopes as Recipe B; store alongside the primary PAT. Throwaway organizations or bot accounts work equivalently.

**Recipe D — validation-suite harness.** Bootstrap the validation suite's environment:

```
# One-time: ensure the validation sandbox repo exists
gh repo create prpande/prism-validation-sandbox --private --description "PRism validation suite sandbox — do not use for other purposes"

# Per validation pass:
cd e2e-validation
npm install                          # if not already done
gh auth login --scopes repo          # primary account; once per machine
npm run setup-fixtures               # creates fixture branches + PRs on prism-validation-sandbox
```

The setup script writes `e2e-validation/fixtures.json` with the actual PR numbers it created.

The validation suite's launcher (in `e2e-validation/playwright.config.ts`) starts PRism via a `webServer` block:

```
ASPNETCORE_ENVIRONMENT=Test            # exposes /test/clear-pr-session + /test/real-inject/*
                                        # does NOT register FakeReviewSubmitter (no PRISM_E2E_FAKE_REVIEW)
PRISM_E2E_REAL_INJECT=1                 # enables route-interception endpoints
DataDir=<per-run temp dir>              # hermetic per run
dotnet run --project ../PRism.Web --no-launch-profile --urls http://localhost:5181 -- --no-browser
```

This command shape matches `frontend/playwright.real.config.ts` (the existing real-flow CI suite) and Phase 1's `playwright.config.ts`:

- `--no-launch-profile` skips Properties/launchSettings.json so the dotnet run env is bounded to what's explicitly passed (no `ASPNETCORE_ENVIRONMENT` from a Development profile leaking through).
- `--no-browser` (after the `--` arg-separator) is consumed by PRism's own CLI handler and suppresses the production binary's auto-open-the-default-browser step; Playwright owns the browser surface for validation.
- `Debug` configuration (the dotnet default) is used rather than `Release` — Release adds significant cold-start time to `dotnet run` and the validation suite doesn't measure perf; Debug build is faster for the iterate-on-the-test cycle.

All other invariants of the production binary apply.

**Recipe E — destructive-only PAT.** J-P2-11 (token expiry) revokes its PAT and breaks every subsequent scenario in the same pass. Generate a third, dedicated PAT for this scenario only, store it separately, never use it for any other scenario. The scenario itself is pinned to run last in any priority pass that includes it (see [Appendix § Pass ordering constraints](#pass-ordering-constraints)).

After Recipe D, the validation suite can be launched by:

```
# Run all scenarios via Playwright
cd e2e-validation
npx playwright test

# Run only P0 smoke
npx playwright test --grep @P0

# Run a specific scenario
npx playwright test --grep "J-P0-04"
```

The orchestrator (in the separate SP2 spec — see [Future stages](#future-stages)) wraps this with reporting; the underlying invocation is straightforward Playwright in `e2e-validation/`.

## Sandbox repository

All scenarios use `prpande/prism-validation-sandbox` as the live mutable repository. **This is a NEW repo, separate from `prpande/prism-sandbox`** (which the existing real-flow suite owns). The separation is deliberate: the black-box isolation contract extends to repo state. Never use any other repo for validation scenarios.

| Fixture name | What it exercises | Used by scenarios |
|---|---|---|
| `happy-path` | Clean multi-commit PR for submit happy path | J-P0-04, J-P2-07, J-P2-08 |
| `foreign-pending-review` | PR seeded with a pre-existing pending review on the user's behalf via gh api | J-P1-03, J-P1-04 |
| `stale-commit-oid` | PR set up so a head advance during a submit attempt triggers the stale-OID flow | J-P1-13 |
| `multi-iteration` | PR with ≥4 distinct iterations (boundary gaps ≥900s per `MinimumBoundaryGapSeconds` constraint) | J-P0-05, J-P0-06, J-P1-09 |
| `single-commit` | PR with exactly one commit (`CommitMultiSelectPicker` fallback) | J-P2-05, V-43 |
| `markdown-with-mermaid` | PR containing a `.md` file with Mermaid + GFM table + code fence | J-P0-08, V-19, V-20 |
| `comment-heavy` | PR with ≥2 pre-existing comment threads on different lines, ≥1 line with multi-thread stack | J-P1-07, J-P2-14, J-P2-15, V-22, V-23 |
| `force-push` | PR with at least one `HeadRefForcePushedEvent` in its timeline | J-P2-06, V-17 |
| `closed-pr-workflow` | Not a fixture; a workflow that uses the `happy-path` fixture + `gh pr close` / `gh pr reopen` | J-P1-05, J-P1-06, J-P2-10, V-29 |
| `throwaway-pr` | Per-scenario PR created and closed by the scenario itself | J-P1-10 inbox-poll, others as needed |

`e2e-validation/scripts/setup-fixtures.ts` creates all fixtures via gh CLI / gh api. Per-fixture implementation notes are in [Appendix § Fixture implementation](#fixture-implementation).

---

# Part 1 — Smoke pass (P0)

Eight scenarios. ~30-45 min total. Required pre-release pass. If any fails, do not ship.

## J-P0-01. First-time setup → routes to inbox
**Priority:** P0
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe A (fresh data dir). Recipe B PAT ready. PRism launched via Recipe D's launcher (Test-env, hermetic dataDir).
**User-actor:** single tester, primary account.
**Steps:**
  1. Open `http://localhost:5181` in the Playwright-controlled browser.
  2. Setup screen renders — confirm host field, PAT textarea, About-local-data block visible.
  3. Paste primary PAT into textarea.
  4. Click Continue.
**Expected:**
  - Setup screen renders without flicker or layout shift.
  - Continue triggers `GET /user` validation; on 200 + non-empty PR probe → routes to `/inbox`.
  - Inbox loads with five section headers (sections may be empty if account has no PRs).
**Failure modes to watch for:**
  - Setup screen shows but Continue does nothing visible (silent validation failure).
  - 401 response after Continue (token rejected) — banner should explain, not crash.
  - Inbox loads but with stale ghost data from a previous session (hermetic dataDir wasn't fresh enough).
**Automation:** Playwright `e2e-validation/specs/j-p0-01-first-time-setup.spec.ts` (NEW).
**Notes:** First-impression scenario. If this breaks, no user reaches anything. The "OS trust dialog" surfaces (Windows SmartScreen, macOS Gatekeeper) are NOT exercised — those happen with the downloaded production binary, outside Playwright's reach; covered as manual-only in Appendix § Out of scope.

## J-P0-02. Open a PR → file tree + diff render with real content
**Priority:** P0
**Wall-clock estimate:** ~2 min
**Pre-conditions:** Recipe D. Authenticated session.
**User-actor:** single tester, primary account.
**Steps:**
  1. From inbox, paste a `happy-path` fixture PR URL into the URL-paste input.
  2. Wait for PR detail mount.
  3. Click the Files tab.
**Expected:**
  - PR header renders (title, author, branch, mergeability, CI summary, verdict picker, Submit button).
  - Three sub-tabs visible (Overview / Files / Drafts). Overview is default.
  - On Files tab: file tree on left with at least one file; diff pane on right showing actual code.
  - Iteration tab strip visible above the two-pane area.
**Failure modes to watch for:**
  - PR mount spins indefinitely (loader skeleton never resolves).
  - File tree renders but diff pane is empty.
  - Diff pane shows raw API response instead of rendered diff.
  - Wrong tab is default-active.
**Automation:** Playwright `e2e-validation/specs/j-p0-02-pr-load.spec.ts` (NEW).

## J-P0-03. Save inline draft → quit → relaunch → draft restored at anchor
**Priority:** P0
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe D. Sandbox happy-path PR open.
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the happy-path PR's Files tab.
  2. Click any code line in any file — composer opens at the anchor.
  3. Type: `validation test draft for J-P0-03`.
  4. Press Ctrl/Cmd+Enter to save.
  5. Confirm the draft appears as an inline widget at the anchor line.
  6. Close the browser tab.
  7. Stop the PRism process (the validation suite's webServer block).
  8. Re-launch with the SAME hermetic dataDir (the suite preserves it between scenarios within a pass).
  9. Navigate back to the same PR.
**Expected:**
  - Saved draft persists across full app shutdown.
  - Re-opened PR shows the draft at the original anchor line with the typed body intact.
  - `state.json` in the hermetic dataDir contains the draft entry under the PR's review session.
**Failure modes to watch for:**
  - Draft saved in memory but never persisted to state.json.
  - Draft anchored to wrong line after relaunch.
  - Draft body truncated or modified by serialization.
**Automation:** Playwright `e2e-validation/specs/j-p0-03-draft-persistence.spec.ts` (NEW).
**Notes:** "The reviewer's text is sacred" — load-bearing wedge promise.

## J-P0-04. Write draft + verdict + submit → review appears correctly on GitHub
**Priority:** P0
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe D. Sandbox happy-path PR. Per-scenario reset via `POST /test/clear-pr-session` (Test-env setup endpoint, raw fetch from spec; the suite owns its `resetSandboxFixture` helper under `e2e-validation/helpers/`).
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the happy-path PR.
  2. Files tab → click a code line → write inline draft: `J-P0-04 inline comment`.
  3. Ctrl/Cmd+Enter to save.
  4. Header → click Approve verdict.
  5. Click Submit Review.
  6. Submit dialog opens — type summary: `J-P0-04 validation submit; please ignore`.
  7. Confirm verdict (Approve), click Confirm Submit.
  8. Wait for success toast: `Review submitted. View on GitHub →`.
  9. Open the PR on github.com (the toast link works; or paste the URL manually).
  10. Verify the review appears on github.com with the summary text + the inline comment correctly anchored to the correct line.
**Expected:**
  - Toast appears within ~5 seconds of Confirm Submit (real network round-trip).
  - On GitHub: review summary matches typed text; verdict shows as Approve; inline comment is anchored to the exact line clicked in step 2.
  - In PRism: `state.json` has no draft entry for this PR after success; `pendingReviewId` cleared.
**Failure modes to watch for:**
  - Silent submit failure (no toast, no error).
  - Inline comment off-by-one (wrong line on GitHub).
  - Summary missing or truncated on GitHub.
  - Verdict differs from what was confirmed.
  - state.json retains the draft after success (cleanup failed).
**Automation:** Playwright `e2e-validation/specs/j-p0-04-submit-end-to-end.spec.ts` (NEW).
**Notes:** The demo-day scenario. If this fails, do not ship.

## J-P0-05. Reload-after-push reconciliation: stale draft classified, submitted
**Priority:** P0
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe D. Sandbox `multi-iteration` fixture (or any sandbox PR where the test can push an additional commit via `gh api`).
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the multi-iteration sandbox PR.
  2. Files tab → click a specific line in a code file → write draft: `J-P0-05 draft on stable line` → save.
  3. Open another draft on a line that the test will subsequently modify → write: `J-P0-05 draft on doomed line` → save.
  4. Via gh CLI (`gh api ...`) push a new commit that modifies the second target line. The validation suite owns this helper under `e2e-validation/helpers/gh-sandbox.ts`.
  5. Wait up to 30s for PRism's poll to detect the new head.
  6. Confirm banner appears: `PR updated — Iteration N available — Reload`.
  7. Click Reload.
  8. Confirm reconciliation panel "Unresolved" section appears with the doomed-line draft flagged as `Stale`.
  9. Click "Keep anyway" on the stale draft (accepting that it may land at the wrong line).
  10. Header → set verdict to Comment.
  11. Submit Review → dialog → summary `J-P0-05 reconciliation validation` → Confirm.
  12. Verify on github.com: both drafts appear as inline comments; the doomed-line one is anchored to whatever line was kept-anyway-resolved.
**Expected:**
  - Banner appears (does not auto-mutate the diff or the drafts).
  - Reconciliation classifies the stable-line draft as `Fresh` (silent re-anchor; no badge); the doomed-line draft as `Stale` (badge; submit-blocking).
  - Keep-anyway flips the doomed draft to `draft` status; submit re-enables.
  - Both drafts land on github.com after submit.
**Failure modes to watch for:**
  - Diff auto-mutates after the push (violates "banner not mutation").
  - Reconciliation misclassifies the stable-line draft as stale (false positive).
  - Submit remains disabled after Keep-anyway.
  - Drafts don't appear on github.com (cleanup-before-success failure).
**Automation:** Playwright `e2e-validation/specs/j-p0-05-reconciliation.spec.ts` (NEW).
**Notes:** The reconciliation wedge — most-novel-vs-github.com behavior.

## J-P0-06. Iteration tabs: click Iter N → diff shows only that iteration's changes
**Priority:** P0
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe D. Sandbox `multi-iteration` fixture (≥4 iterations created with boundary gaps ≥900s).
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the multi-iteration PR.
  2. Files tab — observe iteration tab strip with "All changes" + numbered iterations.
  3. Note the file count + line counts shown in "All changes" view.
  4. Click "Iter 2".
  5. Observe file count + line counts now reflect only Iter 2's changes (smaller than All).
  6. Click "Iter 3" — diff updates again.
  7. Click "All changes" — returns to full PR diff.
**Expected:**
  - Iteration tab clicks update the diff range to `iter_N-1_head..iter_N_head`.
  - File count + line counts change between iterations (Iter N's diff is a strict subset of "All changes" unless Iter N includes a force-push).
  - "All changes" tab restores the full PR diff.
**Failure modes to watch for:**
  - Iteration tab click triggers full PR reload (slow + loses scroll position).
  - Iteration's diff range is wrong (shows All changes or empty).
  - Clicking back to "All changes" leaves the previous iteration's content visible.
**Automation:** Playwright `e2e-validation/specs/j-p0-06-iteration-tabs.spec.ts` (NEW).

## J-P0-07. Banner-on-push: new commit arrives → banner, not auto-mutation
**Priority:** P0
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Recipe D. Sandbox happy-path PR.
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the sandbox PR's Files tab.
  2. Scroll to the bottom of a file's diff.
  3. Note exactly which file + line is under your cursor.
  4. Via gh CLI: push a new commit that does NOT modify the file under your cursor.
  5. Wait up to 30s.
**Expected:**
  - Banner appears at top of PR view: `PR updated — Iteration N available, …`.
  - The diff under the cursor does NOT change. Scroll position is preserved.
  - No drafts (if any) are silently re-anchored.
  - Reload button is visible inside the banner; dismissible X is also visible.
**Failure modes to watch for:**
  - Diff auto-refreshes without Reload click (violates principle).
  - Banner appears but obscures content beneath (layout shift).
  - Scroll position lost.
**Automation:** Playwright `e2e-validation/specs/j-p0-07-banner-on-push.spec.ts` (NEW).
**Notes:** "Banner not mutation" is a load-bearing principle in the spec.

## J-P0-08. Markdown rendering: `.md` file with Mermaid + GFM table
**Priority:** P0
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe D. Sandbox `markdown-with-mermaid` fixture.
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the markdown-with-mermaid sandbox PR.
  2. Files tab → click the `.md` file in the tree.
  3. Confirm Rendered view is the default (not Diff).
  4. Verify the Mermaid diagram renders as a diagram (not raw mermaid source).
  5. Verify the GFM table renders with row/column structure.
  6. Verify code fences are syntax-highlighted via Shiki.
  7. Toggle to Diff view — verify standard code diff renders.
  8. Toggle back to Rendered.
**Expected:**
  - Rendered is the default view for `.md` files.
  - Mermaid renders successfully (not as a code block with raw source).
  - GFM table has visible borders and column alignment.
  - Toggle round-trip preserves view choice.
**Failure modes to watch for:**
  - Mermaid block shows as raw text (lazy-load failed).
  - Mermaid block crashes the rendered view entirely.
  - Mermaid renders but with wrong theme.
  - GFM table shows as plain text with pipes.
**Automation:** Playwright `e2e-validation/specs/j-p0-08-markdown-rendering.spec.ts` (NEW).

---

# Part 2 — Standard pass (P1)

Fourteen scenarios. ~75 min. Pre-release pass for substantial changes.

## J-P1-01. Replace token (same login) → all state preserved
**Priority:** P1
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Authenticated as primary login. At least one saved draft on any sandbox PR. Recipe B can supply a second PAT for the same login (e.g., revoke current PAT and generate a fresh one with the same scopes).
**User-actor:** single tester, primary account.
**Steps:**
  1. Save a draft on any sandbox PR (so there's state to preserve).
  2. Settings → Auth section → click Replace token.
  3. Setup screen renders with host pre-populated; paste the second same-login PAT.
  4. Click Continue.
  5. Navigate back to the PR with the saved draft.
**Expected:**
  - Continue validates new token, recognizes same login, returns to Inbox without clearing drafts.
  - Saved draft still present on the PR.
  - `pendingReviewId`, `threadId`, `replyCommentId` fields (if any existed) preserved.
**Failure modes to watch for:**
  - Drafts cleared even though login is the same.
  - Replace flow drops the user back at first-run Setup instead of "Replace" variant.
**Automation:** Playwright `e2e-validation/specs/j-p1-01-replace-token-same-login.spec.ts` (NEW).

## J-P1-02. Replace token (different login) → drafts kept, pending IDs cleared, foreign-pending modal next submit
**Priority:** P1
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe C (two-login PAT pair). Authenticated as primary login with a draft + a saved `pendingReviewId` from a prior interrupted submit.
**User-actor:** single tester, secondary account available.
**Steps:**
  1. Confirm state: PR has draft + `pendingReviewId` set in state.json.
  2. Settings → Auth → Replace token.
  3. Paste secondary PAT (different login).
  4. Click Continue.
  5. Confirm `pendingReviewId` / `threadId` / `replyCommentId` cleared in state.json; drafts retained.
  6. Navigate to the PR with the prior pending ID.
  7. Click Submit Review.
**Expected:**
  - Identity-change rule fires: drafts preserved, GraphQL Node IDs cleared.
  - Submit attempt surfaces foreign-pending-review modal because the orphan owned by the previous login still exists on github.com.
**Failure modes to watch for:**
  - Drafts cleared on different-login detection (rule misapplied).
  - Foreign-pending modal doesn't appear (orphan-detection failed).
  - Identity-change SSE event doesn't fire (other open tabs miss the change).
**Automation:** Playwright `e2e-validation/specs/j-p1-02-replace-token-different-login.spec.ts` (NEW).

## J-P1-03. Foreign-pending-review modal — Resume path
**Priority:** P1
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe D. A sandbox PR with a pre-existing pending review on the user's behalf, created via the suite's `gh-sandbox` helper.
**User-actor:** single tester, primary account.
**Steps:**
  1. Set up: via gh api, create a pending review on the sandbox PR with one thread containing a comment.
  2. Open the sandbox PR in PRism (verify local state has no `pendingReviewId` or has a mismatched one).
  3. Files tab → write a NEW draft on a different line: `J-P1-03 local draft`.
  4. Set verdict to Comment.
  5. Click Submit Review.
  6. Foreign-pending modal appears: `You have a pending review on this PR from {timestamp}. It contains 1 thread(s) and 0 reply(ies). Resume / Discard / Cancel?`.
  7. Click Resume.
  8. Confirm reconciliation panel now shows the imported foreign draft alongside the local draft.
  9. Confirm both drafts before submit.
  10. Click Confirm Submit.
  11. Verify on github.com: both threads now in the submitted review.
**Expected:**
  - Foreign pending review detected before submit; modal surfaces.
  - Resume imports the foreign threads as drafts (with server-side IDs stamped).
  - Final submit posts both the imported and the local draft as a single review.
**Failure modes to watch for:**
  - Foreign pending review silently adopted without prompting (violates principle).
  - Resume crashes the modal.
  - Imported drafts duplicate the foreign comments on submit.
**Automation:** Playwright `e2e-validation/specs/j-p1-03-foreign-pending-resume.spec.ts` (NEW).

## J-P1-04. Foreign-pending-review modal — Discard path
**Priority:** P1
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Same as J-P1-03.
**User-actor:** single tester, primary account.
**Steps:**
  1. Set up: foreign pending review exists via gh api.
  2. Open PR, write a local draft, set verdict Comment.
  3. Submit Review → modal appears.
  4. Click Discard.
  5. Verify via gh api: the foreign pending review is gone.
  6. Continue with submit dialog → Confirm Submit.
  7. Verify on github.com: only the local draft appears in the submitted review.
**Expected:**
  - Discard deletes the orphan via `deletePullRequestReview`.
  - Pipeline restarts as if no pending review existed.
  - Final submit contains only the local content.
**Failure modes to watch for:**
  - Discard succeeds locally but the orphan remains on github.com.
  - Discard cascades into discarding the local draft.
**Automation:** Playwright `e2e-validation/specs/j-p1-04-foreign-pending-discard.spec.ts` (NEW).

## J-P1-05. Closed PR handling: drafts retained, submit disabled, Discard-all-drafts works
**Priority:** P1
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe D. Sandbox PR opened with a saved draft.
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the sandbox PR with a draft.
  2. From a terminal (or via the suite's gh-sandbox helper): `gh pr close prpande/prism-validation-sandbox/<num>`.
  3. Wait up to 30s for PRism's active-PR poll.
  4. Confirm banner: `This PR is now closed. Submitting a review is no longer possible.`
  5. Confirm Submit Review button is disabled with tooltip.
  6. Open the composer on a code line — confirm Save Draft is disabled; banner inside composer: `PR closed — text not saved`.
  7. Click `Discard all drafts` button next to the disabled Submit.
  8. Confirm modal with count + sample → confirm discard.
  9. Verify `state.json` no longer contains the draft for this PR; `pendingReviewId` (if any) cleared.
**Expected:**
  - Banner appears within poll cadence (~30s).
  - Drafts retained until explicit discard.
  - Discard-all confirmation modal surfaces; explicit confirm required.
  - Local cleanup succeeds even if `deletePullRequestReview` on any orphan fails (with a "may persist" toast).
**Failure modes to watch for:**
  - Banner never appears (poll missed the state transition).
  - Drafts auto-discarded on close-detection (violates principle).
  - Composer Save unexpectedly succeeds on closed PR.
**Automation:** Playwright `e2e-validation/specs/j-p1-05-closed-pr.spec.ts` (NEW).

## J-P1-06. Reopened PR: banner clears, drafts re-reconciled, submit re-enabled
**Priority:** P1
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Continues from J-P1-05 (PR closed with drafts retained; skip J-P1-05's discard step). Alternative: close a sandbox PR with a draft, then run this scenario.
**User-actor:** single tester, primary account.
**Steps:**
  1. Confirm the closed-PR banner is up.
  2. `gh pr reopen prpande/prism-validation-sandbox/<num>`.
  3. Wait up to 30s for poll.
  4. Confirm banner clears; submit button re-enables.
  5. Click Reload (defensive, in case head moved during close-reopen).
  6. Verify reconciliation pass runs over the existing draft.
**Expected:**
  - Banner disappears on reopen.
  - Drafts re-reconciled against current head.
  - Submit re-enables (subject to any other blocking rules).
**Failure modes to watch for:**
  - Banner remains after reopen (state-transition detection failed).
  - Submit stays disabled after reload.
**Automation:** Playwright `e2e-validation/specs/j-p1-06-reopened-pr.spec.ts` (NEW).

## J-P1-07. Reply to existing GitHub comment → threaded correctly after submit
**Priority:** P1
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe D. Sandbox `comment-heavy` fixture. State reset via `/test/clear-pr-session`.
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the comment-heavy sandbox PR.
  2. Files tab → scroll to an existing comment thread.
  3. Click Reply on that thread.
  4. Reply composer opens — type: `J-P1-07 reply via PRism`.
  5. Save the reply.
  6. Set verdict Comment.
  7. Submit Review with summary: `J-P1-07 reply submission`.
  8. Confirm.
  9. Verify on github.com: reply is correctly threaded under the original comment (not a new top-level thread).
**Expected:**
  - Reply composer has the parent thread's ID set as its anchor.
  - Submit attaches the reply via `addPullRequestReviewThreadReply`.
  - On github.com: reply is nested under the original comment.
**Failure modes to watch for:**
  - Reply lands as a new top-level thread (parent ID lost).
  - Reply lands on the wrong file/line.
  - Reply duplicates (lost-response window without marker adoption).
**Automation:** Playwright `e2e-validation/specs/j-p1-07-reply-to-existing-comment.spec.ts` (NEW).

## J-P1-08. Multi-tab consistency: draft in tab A visible in tab B within seconds
**Priority:** P1
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe D. Same sandbox PR ready. **IMPORTANT**: both tabs must share ONE Playwright BrowserContext — BroadcastChannel is scoped to one browsing context group; `browser.newContext()` creates isolated groups that cannot share BroadcastChannel messages.
**User-actor:** single tester, primary account, two browser tabs (same Playwright context).
**Steps:**
  1. Open the sandbox PR in tab A (via `context.newPage()`).
  2. Open the same PR in tab B (via `context.newPage()`).
  3. In tab A: click a line, write draft `J-P1-08 from tab A`, save.
  4. Switch to tab B (do NOT reload).
  5. Observe tab B's diff pane.
**Expected:**
  - Tab B shows the new draft inline within ~3 seconds (BroadcastChannel + SSE `DraftSaved` event).
  - Tab A does NOT re-process its own event (V6 per-tab stamp gate).
  - No reload required in tab B.
**Failure modes to watch for:**
  - Tab B requires reload to see the draft (cross-tab broadcast broken).
  - Tab A re-processes its own draft (echo loop).
  - Draft appears in tab B but on the wrong line.
**Automation:** Playwright `e2e-validation/specs/j-p1-08-multi-tab-consistency.spec.ts` (NEW).

## J-P1-09. Compare picker: pick two iterations + auto-swap + same-iter empty state
**Priority:** P1
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe D. Sandbox `multi-iteration` PR (≥4 iterations).
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the multi-iteration PR's Files tab.
  2. Click "Compare ⇄" picker.
  3. Pick Iter 2 left, Iter 4 right.
  4. Confirm diff updates to `iter_2_head..iter_4_head`.
  5. Now pick Iter 4 left, Iter 2 right.
  6. Confirm picker silently swaps values; "swapped" hint appears briefly.
  7. Pick Iter 3 / Iter 3 (same on both sides).
  8. Confirm diff shows empty state: `No changes between Iter X and Iter X.`
  9. Pick "All changes" — confirm this is NOT in either Compare dropdown.
**Expected:**
  - Picker dropdowns scoped to numbered iterations only.
  - Auto-swap on reverse selection with brief hint.
  - Same-iteration selection renders empty state, not crash.
**Failure modes to watch for:**
  - Reverse selection sends `higher..lower` to backend (broken diff).
  - Swap hint never appears (timing too fast or broken).
  - Same-iter selection crashes diff renderer.
**Automation:** Playwright `e2e-validation/specs/j-p1-09-compare-picker.spec.ts` (NEW).

## J-P1-10. Inbox poll: new PR appears on next refresh
**Priority:** P1
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Recipe D. Inbox open. Note current PR count in each section.
**User-actor:** single tester, primary account.
**Steps:**
  1. Via the suite's gh-sandbox helper: `gh pr create -R prpande/prism-validation-sandbox --title "J-P1-10 throwaway"` to create a new PR.
  2. Wait up to 2 minutes for the inbox poll cycle.
  3. Observe inbox.
**Expected:**
  - Banner appears: `N new updates — Refresh.`
  - Click Refresh → new PR appears in the appropriate section.
  - View does NOT auto-mutate without Refresh click.
**Failure modes to watch for:**
  - Banner never appears within 2x poll cycle (~4 min).
  - Auto-refresh without click (violates principle).
**Automation:** Playwright `e2e-validation/specs/j-p1-10-inbox-poll.spec.ts` (NEW).
**Notes:** Spec teardown closes the throwaway PR + deletes its branch.

## J-P1-11. URL-paste escape hatch: valid same-host navigates, different-host rejects
**Priority:** P1
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Inbox open.
**User-actor:** single tester, primary account.
**Steps:**
  1. Inbox → paste a valid sandbox PR URL.
  2. Confirm navigation.
  3. Return to inbox.
  4. Paste a URL on a different host (e.g., `https://gitlab.com/foo/bar/pull/1`).
  5. Confirm inline error.
  6. Paste a malformed URL (`https://github.com/foo`).
  7. Confirm inline error.
**Expected:**
  - Valid same-host PR URL navigates immediately.
  - Different-host URL rejected with host-mismatch error.
  - Malformed URL rejected with parse error.
**Failure modes to watch for:**
  - Same-host paste fails silently.
  - Different-host paste navigates anyway and crashes the PR view.
**Automation:** Playwright `e2e-validation/specs/j-p1-11-url-paste.spec.ts` (NEW).

## J-P1-12. Settings round-trip: theme + accent + aiPreview + section toggle → persistence
**Priority:** P1
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Authenticated. Default settings.
**User-actor:** single tester, primary account.
**Steps:**
  1. Settings → Appearance → change theme to Dark.
  2. Change accent to Amber.
  3. Toggle aiPreview to ON.
  4. Settings → Inbox sections → hide "Mentioned" section.
  5. Navigate back to Inbox.
  6. Confirm AI placeholders visible.
  7. Stop the PRism process (within the suite's webServer block).
  8. Re-launch with SAME hermetic dataDir.
  9. Open Inbox.
**Expected:**
  - All four changes persist across restart.
  - `config.json` in the hermetic dataDir reflects all changes.
  - Hot-reload during the session is immediate.
**Failure modes to watch for:**
  - One or more settings reset to default on relaunch.
  - Theme change requires reload to take effect.
**Automation:** Playwright `e2e-validation/specs/j-p1-12-settings-roundtrip.spec.ts` (NEW).

## J-P1-13. Stale-OID banner happy path (V6 / SSE wire-fix scenario)
**Priority:** P1
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Recipe D. Sandbox `stale-commit-oid` fixture.
**User-actor:** single tester, primary account.
**Steps:**
  1. Trigger the stale-OID condition: per the stale-commit-oid fixture's helper, simulate the head-advance during a submit attempt.
  2. Confirm stale-OID banner appears in PR view.
  3. Confirm "Recreate and resubmit" button behavior matches Reloaded / not-yet-Reloaded states.
**Expected:**
  - Stale-OID banner fires correctly.
  - The `pr-updated` SSE event uses the object wire shape (`{owner, repo, number}`) per the PR #65 wire fix.
**Failure modes to watch for:**
  - Banner doesn't fire (V6 SSE wire-fix regression).
  - Recreate-and-resubmit button enabled before Reload.
**Automation:** Playwright `e2e-validation/specs/j-p1-13-stale-oid-banner.spec.ts` (NEW).
**Notes:** This scenario overlaps in behavior with the existing CI real-flow spec at `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`. The validation suite keeps its own version for the user-journey-walk perspective (and to honor the isolation contract — no imports). The CI real-flow spec verifies the same outcome via different scaffolding; both are valuable.

## J-P1-14. Keyboard navigation suite: j/k + v + c + n/p
**Priority:** P1
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Recipe D. Multi-file sandbox PR with at least one existing comment thread.
**User-actor:** single tester, primary account.
**Steps:**
  1. Open the PR Files tab.
  2. Press `j` three times — focus moves to next files in the tree.
  3. Press `k` twice — focus moves back.
  4. Press `v` on the focused file — Viewed checkbox toggles.
  5. Click a line in the diff to give focus to a code line.
  6. Press `c` — composer opens at the focused line.
  7. Press Esc to close.
  8. Press `n` to step to next existing comment thread on the file.
  9. Press `p` to step back.
**Expected:**
  - All listed shortcuts behave per the PoC keyboard-shortcuts table in `docs/spec/03-poc-features.md § 9 Keyboard shortcuts`.
**Failure modes to watch for:**
  - Shortcut intercepted by browser.
  - Shortcut works on first press but not on subsequent (event-listener leak).
**Automation:** Playwright `e2e-validation/specs/j-p1-14-keyboard-nav.spec.ts` (NEW).

---

# Part 3 — Comprehensive pass (P2)

Fifteen scenarios. ~75 min. Pre-graduation-milestone passes.

## J-P2-01. Cheatsheet overlay: `?` opens, Esc closes, composer state preserved
**Priority:** P2
**Wall-clock estimate:** ~3 min
**Steps:** 1) Click outside any text input. 2) Press `?` — cheatsheet opens. 3) Press Esc — closes. 4) Open composer, type text, click outside textarea. 5) Press `?` — opens. 6) Press Esc — closes; composer state intact.
**Expected:** Overlay is non-modal; composer underneath retains state. Esc closes overlay only (no composer discard).
**Automation:** Playwright `e2e-validation/specs/j-p2-01-cheatsheet.spec.ts` (NEW).

## J-P2-02. Cheatsheet from inside composer: `Ctrl/Cmd+/` universal chord
**Priority:** P2
**Wall-clock estimate:** ~3 min
**Steps:** 1) Open composer, type, ensure focus inside textarea. 2) Press `?` — `?` typed as literal. 3) Press Ctrl/Cmd+/ — cheatsheet opens. 4) Press Esc — closes; composer text intact + textarea focus restored.
**Expected:** `?` is literal inside text inputs; Ctrl/Cmd+/ is the universal chord.
**Automation:** Playwright `e2e-validation/specs/j-p2-02-cheatsheet-from-composer.spec.ts` (NEW).

## J-P2-03. Verdict re-confirmation: new commit → reload → verdict flipped to needs-reconfirm
**Priority:** P2
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Recipe D. Sandbox PR open.
**Steps:** 1) Click Approve verdict. 2) Push new commit via gh helper. 3) Wait up to 30s for banner. 4) Click Reload. 5) Observe verdict state.
**Expected:** Verdict status flips to `needs-reconfirm` on Reload. Submit blocked until re-confirm. Flip happens on Reload, NOT at poll-detection time.
**Automation:** Playwright `e2e-validation/specs/j-p2-03-verdict-reconfirm.spec.ts` (NEW).

## J-P2-04. In-flight composer when banner arrives: save/discard/cancel modal
**Priority:** P2
**Wall-clock estimate:** ~4 min
**Steps:** 1) Open composer, type text, don't save. 2) Push new commit via gh. 3) Wait for banner. 4) Click Reload.
**Expected:** Modal: `Save as draft, discard, or cancel reload?`. Save is default (Enter).
**Automation:** Playwright `e2e-validation/specs/j-p2-04-inflight-composer.spec.ts` (NEW).

## J-P2-05. Single-commit PR → CommitMultiSelectPicker fallback
**Priority:** P2
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Sandbox `single-commit` fixture.
**Steps:** 1) Open the single-commit PR's Files tab.
**Expected:** No iteration tab strip; `CommitMultiSelectPicker` UI appears.
**Automation:** Playwright `e2e-validation/specs/j-p2-05-single-commit-fallback.spec.ts` (NEW).

## J-P2-06. Force-push iteration banner
**Priority:** P2
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Sandbox `force-push` fixture.
**Steps:** 1) Open PR. 2) Files tab → click force-pushed iteration tab.
**Expected:** Banner: `This iteration includes a force-push; some changes may be upstream merges rather than author changes…`. Informational, not blocking.
**Automation:** Playwright `e2e-validation/specs/j-p2-06-force-push-banner.spec.ts` (NEW).

## J-P2-07. Replies-only review submit
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Sandbox `comment-heavy` fixture.
**Steps:** 1) Open PR. 2) Reply to existing comment. 3) Set verdict Comment. 4) Submit Review → dialog → type summary → Confirm.
**Expected:** Submit enabled with `Replies` non-empty + summary non-empty (no new threads required). Pipeline submits successfully. Review on github.com contains reply + summary, no new inline threads.
**Automation:** Playwright `e2e-validation/specs/j-p2-07-replies-only-submit.spec.ts` (NEW).

## J-P2-08. Empty-pipeline finalize (verdict=Comment + summary only)
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Sandbox PR. Do NOT write drafts or replies.
**Steps:** 1) Open PR. 2) Set verdict Comment. 3) Submit Review → dialog → type summary `J-P2-08 summary only` → Confirm.
**Expected:** Submit enabled when summary alone is present + verdict=Comment. Pipeline runs step 1 (create pending) + step 5 (finalize) only.
**Automation:** Playwright `e2e-validation/specs/j-p2-08-empty-pipeline-finalize.spec.ts` (NEW).

## J-P2-09. Bulk Discard-all-stale-drafts header action
**Priority:** P2
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Recipe D. Sandbox PR with ≥3 drafts. Push a commit that invalidates ≥2 of them.
**Steps:** 1) Write 3 drafts. 2) Push commit deleting those lines via gh. 3) Banner → Reload. 4) Confirm reconciliation panel shows N stale drafts. 5) Click `Discard all N stale drafts`. 6) Confirm modal → Confirm.
**Expected:** All stale drafts cleared. Other drafts intact. Submit re-enables if no other blocker.
**Automation:** Playwright `e2e-validation/specs/j-p2-09-bulk-discard-stale.spec.ts` (NEW).

## J-P2-10. Discard-all-drafts on closed PR → orphan cleanup toast
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Closed sandbox PR with a draft + `pendingReviewId` (orphan on github.com).
**Steps:** 1) Click `Discard all drafts`. 2) Confirm modal → confirm. 3) Observe toast.
**Expected:** Local drafts always cleared. If orphan-delete on github.com fails: toast: `Local drafts cleared. The pending review on GitHub may persist; it will be cleaned up on the next successful submit on this PR.`
**Automation:** Playwright `e2e-validation/specs/j-p2-10-discard-orphan-cleanup.spec.ts` (NEW).

## J-P2-11. Token expiry mid-session → redirect to Setup with banner, drafts preserved
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe E (dedicated destructive PAT). The validation pass MUST run J-P2-11 LAST in any pass that includes it — see [Appendix § Pass ordering constraints](#pass-ordering-constraints).
**User-actor:** single tester, dedicated destructive PAT.
**Steps:**
  1. Authenticate the suite using Recipe E PAT.
  2. Save a draft on a sandbox PR.
  3. On github.com, revoke the Recipe E PAT.
  4. Trigger an API call in PRism (reload the inbox, or open another PR).
**Expected:**
  - 401 wrapper detects → routes to Setup screen with banner: `Your token has expired. Generate a new one.`
  - Drafts preserved in state.json (the hermetic dataDir for this pass).
**Failure modes to watch for:**
  - Redirect happens but drafts cleared.
  - 401 propagates as an unhandled exception toast.
**Automation:** Playwright `e2e-validation/specs/j-p2-11-token-expiry.spec.ts` (NEW). The spec is tagged `@destructive @last-in-pass`; the orchestrator (SP2) enforces ordering.
**Notes:** Destructive — revokes the Recipe E PAT. The PAT is dedicated; this scenario does not affect Recipe B or other passes. Recipe E must be regenerated before the next pass that includes J-P2-11.

## J-P2-12. Inbox 5-section dedup behavior
**Priority:** P2
**Wall-clock estimate:** ~4 min
**Pre-conditions:** A sandbox PR authored by the primary user with failing CI (seed via gh api to mark a check as failing).
**Steps:** 1) Open inbox. 2) Observe sections 3 (Authored by me) and 5 (CI failing).
**Expected:** PR appears in section 5 only, not section 3 (default dedup). Setting `inbox.deduplicate: false` in config.json restores non-dedup behavior.
**Automation:** Playwright `e2e-validation/specs/j-p2-12-inbox-dedup.spec.ts` (NEW).

## J-P2-13. Inbox unread badges: new-commits + new-comments after teammate push
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Recipe D + Recipe C (secondary account for teammate actions). Sandbox PR previously opened in PRism so marks are set.
**Steps:** 1) Open a sandbox PR so marks are set. 2) Return to inbox. 3) Note no unread badges. 4) Using secondary account's gh auth, push a commit + add a comment. 5) Wait up to 2 min for inbox poll → click Refresh on banner.
**Expected:** Row shows badge: `🔵 1 new commit` AND/OR `💬 1 new comment`. First-visit suppression honored.
**Automation:** Playwright `e2e-validation/specs/j-p2-13-inbox-unread-badges.spec.ts` (NEW).

## J-P2-14. Existing comment edited on github.com → "edited" badge after reload
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Sandbox `comment-heavy` PR with at least one existing comment.
**Steps:** 1) Open PR. Note the body of one comment. 2) Edit via gh api. 3) Wait for poll → click Reload.
**Expected:** Comment renders with new body. Small "edited" badge with timestamp visible.
**Automation:** Playwright `e2e-validation/specs/j-p2-14-comment-edited.spec.ts` (NEW).

## J-P2-15. Existing comment deleted → draft reply becomes stale on Reload
**Priority:** P2
**Wall-clock estimate:** ~5 min
**Pre-conditions:** Sandbox `comment-heavy` PR with a draft reply to one of the existing comments.
**Steps:** 1) Write draft reply (per J-P1-07). 2) Delete the parent comment via gh api. 3) Wait for poll → click Reload.
**Expected:** Reply flips to `status = stale, reason = "the thread you replied to has been deleted"`. Submit blocked. User can discard or rewrite as new top-level comment.
**Automation:** Playwright `e2e-validation/specs/j-p2-15-comment-deleted-reply-stale.spec.ts` (NEW).

---

# Part 4 — Polish pass (P3)

Seven scenarios. ~25 min. Opportunistic.

## J-P3-01. Markdown live-preview toggle in inline composer
**Priority:** P3
**Wall-clock estimate:** ~3 min
**Steps:** 1) Open composer on a line. 2) Confirm live-preview OFF by default. 3) Toggle ON. 4) Type markdown (`**bold** _italic_` + a code fence). 5) Confirm preview pane renders live. 6) Toggle OFF.
**Automation:** Playwright `e2e-validation/specs/j-p3-01-composer-preview-toggle.spec.ts` (NEW).

## J-P3-02. Composer discard-confirm semantics
**Priority:** P3
**Wall-clock estimate:** ~4 min
**Steps:** 1) Open composer, type text. 2) Click a DIFFERENT line — confirm modal: `Discard or save current comment?`. Test both branches. 3) Open composer, type text. 4) Press Esc — confirm same modal.
**Automation:** Playwright `e2e-validation/specs/j-p3-02-composer-discard.spec.ts` (NEW).

## J-P3-03. AI placeholder behavior: aiPreview ON → canned content at every slot
**Priority:** P3
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Sandbox PR loaded.
**Steps:** 1) Settings → toggle aiPreview ON. 2) Inbox → confirm category chips + activity rail visible. 3) PR Overview → AI summary card visible. 4) PR Files → focus dots visible in tree. 5) Submit dialog → validator card + Ask AI empty state visible.
**Expected:** Every slot renders canned content; none crash; none distort layout.
**Automation:** Playwright `e2e-validation/specs/j-p3-03-ai-preview-on.spec.ts` (NEW).

## J-P3-04. Activity rail breakpoint: collapses at 1180px regardless of aiPreview
**Priority:** P3
**Wall-clock estimate:** ~3 min
**Pre-conditions:** aiPreview ON. Inbox at 1440x900.
**Steps:** 1) Confirm rail visible. 2) Resize to 1180x800. 3) Confirm rail hidden. 4) Resize back. 5) Confirm rail reappears. 6) Toggle aiPreview OFF at 1440x900 — confirm rail hidden.
**Expected:** Rail visible iff `aiPreview === true && viewport-width >= 1180px`.
**Automation:** Playwright `e2e-validation/specs/j-p3-04-rail-breakpoint.spec.ts` (NEW).

## J-P3-05. State migration on relaunch: older state.json migrates silently
**Priority:** P3
**Wall-clock estimate:** ~4 min
**Pre-conditions:** PRism running with current-schema state.json in the suite's hermetic dataDir.
**Steps:** 1) Stop PRism. 2) Edit `<dataDir>/state.json` to set `"version": 1` (suite writes directly; no human backup needed since the hermetic dataDir is per-run). 3) Re-launch.
**Expected:** Backend detects v1 → walks migrations → renames source to `state.json.v1.bak` → starts cleanly. No errors.
**Failure modes to watch for:** Migration crash leaves state.json inconsistent.
**Automation:** Playwright `e2e-validation/specs/j-p3-05-state-migration.spec.ts` (NEW).

## J-P3-06. Whitespace-only changes rendered truthfully (no filtering)
**Priority:** P3
**Wall-clock estimate:** ~3 min
**Pre-conditions:** Sandbox PR with at least one whitespace-only change.
**Steps:** 1) Open PR → Files tab → navigate to whitespace-changed file.
**Expected:** Whitespace change shown as-is, NO filtering.
**Automation:** Playwright `e2e-validation/specs/j-p3-06-whitespace-truthful.spec.ts` (NEW).

## J-P3-07. Active-PR poll observed every ~30s (CI status flip + new-comment delta surfacing)
**Priority:** P3
**Wall-clock estimate:** ~4 min
**Pre-conditions:** Recipe D + Recipe C. Sandbox PR open in PRism.
**Steps:** 1) From secondary account: add a comment via gh api. 2) Watch PR view; time how long until banner surfaces.
**Expected:** Banner appears within ~30s of API change.
**Automation:** Playwright `e2e-validation/specs/j-p3-07-active-poll-cadence.spec.ts` (NEW).

---

# Part 5 — Visual review pack (V-1..V-44)

Capture-oriented cases for design / layout / typography / contrast / motion analysis. Each V-case produces a screenshot bundle fed to a Claude session with a canned per-case prompt for analysis.

**Workflow status as of 2026-05-28: unvalidated.** Run V-1 (Setup screen) end-to-end first: capture, bundle, feed to Claude, evaluate whether returned findings are useful. If V-1 round delivers value, continue with V-2..V-44. If it doesn't, revise the prompt template before committing to the remaining 43 cases — or remove Part 5 entirely if the model doesn't pay off. **Quick reference: see [When-to-run table](#when-to-run) which links this pilot gate.**

Each V-case carries a priority similar to journey scenarios:

- **P0** — wedge surfaces that everyone sees daily and have to look right.
- **P1** — major surfaces present in most user sessions.
- **P2** — secondary surfaces or specific states.
- **P3** — polish, motion, edge states.

Per-case shape:

```
## V-N. <surface name>
**Priority:** P0 | P1 | P2 | P3
**Setup:** <how to reach this state>
**Viewport:** <1440x900 default | 1180x800 for breakpoint check>
**Capture:** <single shot | sequence | grid>
**Variants to shoot:** <list — each becomes a PNG filename>
**Bundle as:** V-N-<slug>/ folder with one PNG per variant.
**Send-to-Claude prompt:** <one-paragraph evaluation brief — what to look at, what counts as a finding, what is out of scope>
```

## V-1. Setup screen variants — Priority: P0
- **Setup:** Recipe A + Recipe D launcher; pause at Setup screen.
- **Viewport:** 1440x900.
- **Capture:** Sequence of 6.
- **Variants to shoot:** empty / typed-host / typed-host-with-validation-warning / typed-PAT / continue-401-inline-error (paste an obviously-bad PAT, click Continue, capture the rejection state) / post-Continue-loading.
- **Bundle as:** `V-1-setup/`.
- **Send-to-Claude prompt:** "First-run Setup screen for PRism. Evaluate: visual hierarchy of host vs PAT vs Continue; clarity of validation inline messages (warning / error / corrective accept); whether the About-local-data block is visible-but-not-alarming; whether Continue's loading state communicates clearly; whether the 401 inline-error variant reads as 'token rejected, paste again' vs 'something is broken'. **Out of scope:** the PAT link copy, the specific permission list text. Look for: alignment issues, cramped spacing, unclear field affordances, unintentional visual weight on warnings."

## V-2. Inbox — all five sections populated — Priority: P1
- **Setup:** As J-P0-02 (after navigating into a populated inbox).
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** populated.
- **Bundle as:** `V-2-inbox-populated/`.
- **Send-to-Claude prompt:** "PRism inbox with five sections each populated. Evaluate: section heading hierarchy, row density, badge placement, scan-ability for 'what do I need to do next'. The activity rail on the right is canned data — ignore content, evaluate placement. **Out of scope (spec-mandated):** the five section names and their ordering; the per-row metadata fields; the section-collapse-with-count affordance; the dedup default rule. Look for: rows that don't visually separate, unclear badge prominence, repo/author balance, age column readability."

## V-3. Inbox — empty (cold-start) — Priority: P2
- **Setup:** Recipe A + B with a freshly-created GitHub account that has no PRs.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** empty.
- **Bundle as:** `V-3-inbox-empty/`.
- **Send-to-Claude prompt:** "PRism inbox with zero PRs in all five sections. Evaluate: warmth of the empty-state hint, balance of the five section placeholders. Look for: empty-state that feels broken vs feels expected; whether the URL-paste affordance reads as a recovery path."

## V-4. Inbox — banner up + scope footer — Priority: P2
- **Setup:** J-P1-10 setup for banner + a PAT with limited scope for the footer.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** with-banner-and-footer.
- **Bundle as:** `V-4-inbox-banner-footer/`.
- **Send-to-Claude prompt:** "PRism inbox with the 'N new updates — Refresh' banner and the token-scope footer. Evaluate: banner prominence, footer subtlety, whether they compete for attention. Look for: visual stacking issues, banner pushing content."

## V-5. Inbox — activity rail on vs off (incl. 1180px breakpoint) — Priority: P2
- **Setup:** Settings toggle aiPreview off/on + resize for breakpoint.
- **Viewport:** 1440x900 for the two flag shots; 1180x800 for the breakpoint shot.
- **Capture:** Three shots.
- **Variants to shoot:** rail-off-1440 / rail-on-1440 / rail-on-1180.
- **Bundle as:** `V-5-activity-rail/`.
- **Send-to-Claude prompt:** "PRism inbox in three states: activity rail off at 1440x900; rail on at 1440x900; rail on at 1180x800 (rail should be hidden by CSS breakpoint). Evaluate: grid collapse between off/on at 1440; breakpoint shot collapses cleanly; rail items have appropriate visual weight. **Out of scope:** rail content (canned); the 1180px breakpoint threshold itself (spec-mandated). Look for: column-balance issues, leftover empty space at the breakpoint, visual discontinuity."

## V-6. Inbox row badges — Priority: P2
- **Setup:** Multiple PRs with badge differences.
- **Viewport:** 1440x900, crop to inbox rows.
- **Capture:** Single shot.
- **Variants to shoot:** badge-variants.
- **Bundle as:** `V-6-row-badges/`.
- **Send-to-Claude prompt:** "PRism inbox rows showing different badge states (commits / comments / both). Evaluate: badge legibility, distinction between commit dot vs comment dot, right-aligned stack reads cleanly. Look for: visual collision with age column, color-contrast issues."

## V-7. Header — three-tab nav + popout — Priority: P1
- **Setup:** Any page; open header pop-out.
- **Viewport:** 1440x900, crop to header band.
- **Capture:** Two shots.
- **Variants to shoot:** nav-only / popout-open.
- **Bundle as:** `V-7-header/`.
- **Send-to-Claude prompt:** "PRism app header: three-tab nav (**Inbox / Settings / Setup** — Setup gets a `·` first-run indicator; PR detail is reached by row-click and is NOT a top-level tab) plus right-side controls popout. Evaluate: active-tab indicator, popout placement, integration. **Out of scope (spec-mandated):** tab names, tab order. Look for: tab indicator strength, popout shadow/elevation, alignment."

## V-8. PR detail — Overview tab — Priority: P1
- **Setup:** Open a sandbox PR.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** overview-full.
- **Bundle as:** `V-8-overview/`.
- **Send-to-Claude prompt:** "PRism PR detail — Overview tab. Hero card, PR description, stats, conversation, 'Review files' CTA. Evaluate: hero card weight, vertical rhythm, CTA discoverability."

## V-9. Overview — AI summary slot (aiPreview off vs on) — Priority: P3
- **Setup:** Same PR. Toggle aiPreview.
- **Viewport:** 1440x900, crop to hero card.
- **Capture:** Two shots.
- **Variants to shoot:** ai-off / ai-on.
- **Bundle as:** `V-9-ai-summary/`.
- **Send-to-Claude prompt:** "PRism Overview hero card with AI summary slot off vs on. Per spec, slot reserves no extra space when off. Evaluate: off-state hero feels intentionally compact (not truncated); on-state's canned summary feels integrated. Look for: visible space reservation in the off state (spec violation), visual upheaval between states."

## V-10. Files tab — full layout — Priority: P0
- **Setup:** Open a sandbox PR's Files tab.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** files-tab-full.
- **Bundle as:** `V-10-files-tab/`.
- **Send-to-Claude prompt:** "PRism Files tab — iteration tab strip, file tree on left, side-by-side diff pane. Evaluate: column proportions, iteration tab strip distinction from page header, file tree row density. Look for: cramped diff, file tree column too narrow/too wide."

## V-11. File tree — smart-compacted long path — Priority: P2
- **Setup:** A PR touching a deeply-nested file.
- **Viewport:** 1440x900, crop to file tree.
- **Capture:** Single shot.
- **Variants to shoot:** smart-compacted.
- **Bundle as:** `V-11-tree-compaction/`.
- **Send-to-Claude prompt:** "PRism file tree showing smart-compacted single-child directory chains. Evaluate: readability of compacted path, distinction from non-compacted directory, indent rhythm. **Out of scope (spec-mandated):** the compaction algorithm itself; the per-directory viewed-rollup format (V-12). Look for: path that wraps awkwardly, compacted row that looks like a regular file."

## V-12. File tree — viewed rollups at varied ratios — Priority: P2
- **Setup:** Toggle Viewed on files to produce 3/7, 7/7, 0/12 rollups.
- **Viewport:** 1440x900, crop to file tree.
- **Capture:** Single shot.
- **Variants to shoot:** rollups-mixed.
- **Bundle as:** `V-12-rollups/`.
- **Send-to-Claude prompt:** "PRism file tree with per-directory viewed rollups at 3/7, 7/7, 0/12. Evaluate: rollup readability, whether 7/7 reads as 'done' visually, color/weight of count. Look for: rollups that vanish into the row, fully-viewed directory not feeling closed-out."

## V-13. Diff — side-by-side, word-level + whitespace — Priority: P1
- **Setup:** Files tab, pick a file with word-level changes + whitespace changes.
- **Viewport:** 1440x900, crop to diff pane (one hunk).
- **Capture:** Single shot.
- **Variants to shoot:** sxs-word-ws.
- **Bundle as:** `V-13-diff-sxs/`.
- **Send-to-Claude prompt:** "PRism side-by-side diff showing word-level highlights and whitespace changes. Evaluate: highlight contrast, whitespace marker visibility (intentional truthfulness), Shiki balance with diff colors. Look for: highlight colors clashing with syntax tokens, whitespace markers overwhelming the line."

## V-14. Diff — unified view of same hunk — Priority: P2
- **Setup:** From V-13, toggle to unified.
- **Viewport:** 1440x900, crop.
- **Capture:** Single shot.
- **Variants to shoot:** unified.
- **Bundle as:** `V-14-diff-unified/`.
- **Send-to-Claude prompt:** "PRism unified diff (same hunk as V-13). Evaluate: +/- marker prominence vs syntax highlighting, line-number column readability, whether unified mode feels intentional vs degraded. Look for: marker columns blending into gutters."

## V-15. Diff — truncation banner — Priority: P3
- **Setup:** A PR with >3000 files. Rare; skip if not available.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** truncated.
- **Bundle as:** `V-15-truncation/`.
- **Send-to-Claude prompt:** "PRism diff truncation banner when PR exceeds 3000 files. Evaluate: visibility, tone (helpful pointer not failure), placement. Look for: banner that feels apologetic or buried."

## V-16. Iteration tabs — All + inline + dropdown + Compare — Priority: P1
- **Setup:** Sandbox multi-iteration PR.
- **Viewport:** 1440x900, crop to tab strip + first row of content below.
- **Capture:** Single shot.
- **Variants to shoot:** iter-strip.
- **Bundle as:** `V-16-iteration-strip/`.
- **Send-to-Claude prompt:** "PRism iteration tab strip: 'All changes' + last 3 inline + 'All iterations ▾' dropdown + 'Compare ⇄' picker. Compare picker is positioned right of dropdown on same horizontal strip. Evaluate: active-tab indicator clarity, dropdown affordance, Compare picker visual relationship to rest of strip. **Out of scope (spec-mandated):** the All / Last-3-inline / older-dropdown structure; Compare picker existence and position. Look for: Compare picker reading as decorative, active-tab indicator that doesn't survive a glance."

## V-17. Iteration tab — force-push banner — Priority: P2
- **Setup:** Open force-pushed iteration tab.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** force-push-banner.
- **Bundle as:** `V-17-force-push-banner/`.
- **Send-to-Claude prompt:** "PRism iteration view with force-push banner. Evaluate: banner weight (informational not blocking), copy clarity, position relative to diff. Look for: banner reading as 'something is broken' rather than 'heads up'."

## V-18. Compare picker — swap hint + same-iteration empty — Priority: P2
- **Setup:** Trigger auto-swap; capture brief 'swapped' hint. Separately, pick Iter 3 / Iter 3.
- **Viewport:** 1440x900, crop to picker + immediate area.
- **Capture:** Two shots.
- **Variants to shoot:** swapped-hint / same-iter-empty.
- **Bundle as:** `V-18-compare-states/`.
- **Send-to-Claude prompt:** "PRism Compare picker in two states: auto-swap with brief 'swapped' hint; same iteration both sides showing 'No changes between Iter X and Iter X.' Evaluate: hint legibility in brief window, empty-state tone. Look for: hint too fleeting to read, empty state looks like an error."

## V-19. Markdown — Mermaid + GFM + code — Priority: P1
- **Setup:** Open `markdown-with-mermaid` fixture's `.md` file in Rendered view.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** md-rendered.
- **Bundle as:** `V-19-markdown-rendered/`.
- **Send-to-Claude prompt:** "PRism Rendered markdown of `.md` with Mermaid + GFM table + code blocks. Evaluate: Mermaid theming matches app theme, table grid weight, code block treatment matches diff Shiki output. Look for: Mermaid pops out of app style, table borders too heavy."

## V-20. Markdown — Rendered vs Diff toggle — Priority: P2
- **Setup:** Same `.md` in both modes.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** rendered / diff.
- **Bundle as:** `V-20-md-toggle/`.
- **Send-to-Claude prompt:** "PRism `.md` Rendered vs Diff. Evaluate: toggle affordance, continuity between views. Look for: toggle that feels disconnected, jarring transition."

## V-21. Inline composer — open with markdown + preview off (default) — Priority: P1
- **Setup:** Click a line; type markdown.
- **Viewport:** 1440x900, crop to composer.
- **Capture:** Single shot.
- **Variants to shoot:** composer-default.
- **Bundle as:** `V-21-composer/`.
- **Send-to-Claude prompt:** "PRism inline composer with typed markdown and live-preview default-off (compact for line-level). Evaluate: composer height (compact per spec), Save/Discard placement, preview toggle discoverability."

## V-22. Reply composer — Priority: P2
- **Setup:** PR with existing comment thread; click Reply.
- **Viewport:** 1440x900, crop to thread + composer.
- **Capture:** Single shot.
- **Variants to shoot:** reply-composer.
- **Bundle as:** `V-22-reply/`.
- **Send-to-Claude prompt:** "PRism reply composer attached to existing thread. Evaluate: visual relationship to parent (indented? badged?), distinction from top-level composer. Look for: reply looking like new top-level comment."

## V-23. Existing inline comment — multi-thread stack on one line — Priority: P3
- **Setup:** PR with multiple threads on the same line (`comment-heavy` fixture).
- **Viewport:** 1440x900, crop.
- **Capture:** Single shot.
- **Variants to shoot:** multi-stack.
- **Bundle as:** `V-23-multi-stack/`.
- **Send-to-Claude prompt:** "PRism diff with multiple threads stacked on same line. Evaluate: thread separation, stacking order, reading flow. Look for: threads bleeding into each other."

## V-24. Reconciliation panel — every badge variant in one shot — Priority: P1
- **Setup:** Build the panel by combining J-P0-05's commit pattern (produces Fresh + Stale) with two additional commit patterns: (a) push a commit that moves the anchored line elsewhere (produces `Moved`), and (b) push a commit that moves the line AND duplicates the line content elsewhere (produces `Moved-ambiguous`). The Fresh-but-ambiguous variant arises naturally if the multi-iteration fixture has a duplicated-line context. The setup helper in `e2e-validation/helpers/reconciliation-fixtures.ts` codifies these three patterns into one PR state.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** panel-all-badges.
- **Bundle as:** `V-24-reconcile/`.
- **Send-to-Claude prompt:** "PRism Unresolved reconciliation panel with all four badge variants visible. Evaluate: visual distinction between Stale (blocks submit) and soft variants; per-action button cluster (Show me / Edit / Delete / Keep anyway) hierarchy; Discard-all header button weight. **Out of scope (spec-mandated):** the action set itself; the 'reviewer's text is sacred' principle; the classification taxonomy. Look for: badges that don't distinguish action-required from informational; Discard-all reading as primary CTA when it's destructive bulk."

## V-25. Verdict picker — needs-reconfirm + disabled-Submit tooltip — Priority: P1
- **Setup:** Verdict set, banner up; hover the disabled Submit.
- **Viewport:** 1440x900, crop to header band.
- **Capture:** Two shots.
- **Variants to shoot:** needs-reconfirm / tooltip-visible.
- **Bundle as:** `V-25-verdict/`.
- **Send-to-Claude prompt:** "PRism verdict picker in needs-reconfirm state + disabled-Submit tooltip on banner drift. Evaluate: needs-reconfirm visual treatment (warning glow? dimmed?), tooltip clarity. Look for: needs-reconfirm state invisible at a glance, tooltip too small to read."

## V-26. Submit dialog — validator + Ask AI + Verdict + Summary + Preview — Priority: P1
- **Setup:** Open submit dialog with aiPreview off (no validator); take shot. Toggle on; take shot.
- **Viewport:** 1440x900 (dialog modal).
- **Capture:** Two shots.
- **Variants to shoot:** dialog-ai-off / dialog-ai-on.
- **Bundle as:** `V-26-submit-dialog/`.
- **Send-to-Claude prompt:** "PRism Submit confirmation dialog. Variant 1: aiPreview off — verdict picker, summary textarea + live preview, thread/reply counts, no validator. Variant 2: aiPreview on — adds canned `PreSubmitValidatorCard` + `Ask AI` button with 'coming in v2' empty state. Evaluate: dialog vertical pacing in both states, AI additions feel integrated. Look for: dialog growing uncomfortably between off/on, AI competing with Confirm button."

## V-27. Foreign-pending-review modal — Priority: P1
- **Setup:** J-P1-03 / J-P1-04 setup; trigger modal twice.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** resume-state / discard-state.
- **Bundle as:** `V-27-foreign-pending/`.
- **Send-to-Claude prompt:** "PRism foreign-pending-review modal: Resume confirmation (foreign threads/replies count + age) vs Discard confirmation. Evaluate: modal copy clarity, Resume vs Discard button distinction (both destructive in different ways), Cancel visibility. Look for: copy that doesn't explain what 'Resume' or 'Discard' means, button hierarchy pushing wrong default."

## V-28. Stale-commitOID retry banner — Reloaded vs not-yet-Reloaded — Priority: P2
- **Setup:** Stale-OID condition with Recreate-and-resubmit button visible.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** not-reloaded / reloaded.
- **Bundle as:** `V-28-stale-oid/`.
- **Send-to-Claude prompt:** "PRism stale-commitOID retry banner in two states. Evaluate: visual distinction between disabled vs enabled Recreate-and-resubmit, copy clarity. Look for: disabled state looks like a bug, enabled state doesn't differentiate from disabled."

## V-29. Closed/merged PR banner + Discard-all-drafts — Priority: P2
- **Setup:** J-P1-05 setup; have drafts.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** closed-with-discard.
- **Bundle as:** `V-29-closed-pr/`.
- **Send-to-Claude prompt:** "PRism PR detail with 'This PR is now closed' banner + 'Discard all drafts' button. Evaluate: banner tone (informational not alarmed), Discard button weight (destructive but not primary). Look for: panic-inducing banner, Discard reading as next obvious action."

## V-30. Active-PR banner — full copy — Priority: P1
- **Setup:** J-P0-07.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** banner.
- **Bundle as:** `V-30-active-pr-banner/`.
- **Send-to-Claude prompt:** "PRism active-PR banner: 'PR updated — Iteration N available, X new comments — Reload'. Evaluate: copy density, Reload prominence, dismiss-X visibility. Look for: copy wrapping awkwardly, Reload not reading as primary action."

## V-31. In-flight composer modal — Priority: P2
- **Setup:** Composer with text + click Reload.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** in-flight-modal.
- **Bundle as:** `V-31-in-flight-modal/`.
- **Send-to-Claude prompt:** "PRism modal on Reload-with-non-empty-composer: 'Save as draft, discard, or cancel reload?'. Evaluate: three-button hierarchy (Save is default Enter), modal weight, copy clarity. Look for: three-button modal not distinguishing primary, Save default not visually obvious."

## V-32. Toast variants — success / warning / error / 429 — Priority: P2
- **Setup:** Trigger each variant (429 is rare without rate-burning).
- **Viewport:** 1440x900, crop to corner.
- **Capture:** Single shot, four-up grid.
- **Variants to shoot:** four-up.
- **Bundle as:** `V-32-toasts/`.
- **Send-to-Claude prompt:** "PRism toast notifications in four variants: success, warning, error, 429-rate-limit. Evaluate: variant distinction, auto-dismiss timing (success auto-dismisses), stacking. Look for: variants not differentiating enough, dismiss-X hard to hit."

## V-33. Cheatsheet overlay — full + with composer-open + dim — Priority: P2
- **Setup:** Open cheatsheet from PR view + from inside composer.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** standalone / composer-underneath.
- **Bundle as:** `V-33-cheatsheet/`.
- **Send-to-Claude prompt:** "PRism cheatsheet overlay: opened over PR view; opened with composer active underneath. Evaluate: shortcut grid scan-ability, dim treatment (non-modal — composer accessible), close affordance. Look for: cheatsheet trapping focus visually, dim making composer look disabled."

## V-34. Branded LoadingScreen + favicon — Priority: P1
- **Setup:** Recipe A; capture launch loading screen + browser tab favicon.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** loading-screen / favicon-tab.
- **Bundle as:** `V-34-branding/`.
- **Send-to-Claude prompt:** "PRism launch: branded LoadingScreen + favicon. Evaluate: loading screen pacing (intentional not anxious), favicon recognizability at tab scale, brand consistency. Look for: loading screen lingering without progress signal, favicon not reading at 16px."

## V-35. Settings page — all four sections — Priority: P1
- **Setup:** Open Settings; default + after edits.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** default / edited.
- **Bundle as:** `V-35-settings/`.
- **Send-to-Claude prompt:** "PRism Settings page (Appearance, Inbox sections, Connection, Auth) — default + after edits. Evaluate: section heading hierarchy, control placement consistency, optimistic-save toast, Replace token affordance prominence in Auth. Look for: sections feeling inconsistent, Auth section not distinguishing from less-destructive sections."

## V-36. Replace token flow — Setup re-prompt + identity-change confirm — Priority: P2
- **Setup:** J-P1-02 flow; capture Setup screen after Replace click + identity-change confirmation.
- **Viewport:** 1440x900.
- **Capture:** Two shots.
- **Variants to shoot:** setup-prepopulated / identity-change.
- **Bundle as:** `V-36-replace-token/`.
- **Send-to-Claude prompt:** "PRism Replace-token flow. Evaluate: how clearly Replace mode differs from first-run Setup, identity-change copy (high-stakes confirmation), preserved-vs-cleared state explanation. Look for: Replace mode looking identical to first-run, identity-change copy not making consequences explicit."

## V-37. Theme × accent matrix — 6-up + focus-ring walk per combo — Priority: P1
- **Setup:** Pick PR detail Files tab. For each of 6 theme×accent combos, capture rest + Tab-focused on verdict picker / file-tree row.
- **Viewport:** 1440x900.
- **Capture:** Twelve shots — six rest + six focus.
- **Variants to shoot:** light-indigo-rest / light-indigo-focus / light-amber-rest / light-amber-focus / light-teal-rest / light-teal-focus / dark-indigo-rest / dark-indigo-focus / dark-amber-rest / dark-amber-focus / dark-teal-rest / dark-teal-focus.
- **Bundle as:** `V-37-theme-accent/`.
- **Send-to-Claude prompt:** "PRism PR detail Files tab in all six theme×accent combos, each rest + focused. **Apply WCAG 2.1 AA contrast ratios as pass/fail bar**: 4.5:1 body text against background; 3:1 large text and interactive borders/focus indicators against adjacent backgrounds. Flag any combination where verdict picker label, file-tree row text, focus ring, or selected-row highlight falls below the ratio. Beyond contrast: evaluate accent strength balance, any combo feels weaker as daily-driver UI. **Out of scope (spec-mandated):** the three accents, three themes, choice to ship 6 combos, specific oklch hues. Look for: dark+amber legibility (most fragile combo); light+teal differentiation from neutral; any combo losing focus rings."

## V-38. a11y — keyboard focus through landmarks — Priority: P1
- **Setup:** Tab through interactive elements from cold start.
- **Viewport:** 1440x900.
- **Capture:** Sequence of 3-4.
- **Variants to shoot:** focus-header / focus-main / focus-tree / focus-composer.
- **Bundle as:** `V-38-a11y-focus/`.
- **Send-to-Claude prompt:** "PRism keyboard-focus walk: header → main → file tree → composer. Evaluate: focus ring visibility on every element (WCAG-AA contrast), tab order intuitiveness, focusable elements losing rings (regression risk). Look for: missing focus rings, low-contrast against accents, focus skipping off-viewport."

## V-39. Empty PR — file tree empty + placeholder — Priority: P3
- **Setup:** A PR with no commits beyond base.
- **Viewport:** 1440x900.
- **Capture:** Single shot.
- **Variants to shoot:** empty-pr.
- **Bundle as:** `V-39-empty-pr/`.
- **Send-to-Claude prompt:** "PRism PR detail with empty file tree + placeholder. Evaluate: empty-state tone (informational not error), Submit state (disabled with explanation; Comment-with-summary still possible). Look for: empty state reads as broken, Submit looks unconditionally disabled."

## V-40. Error states — 404, network drop, 401 banner — Priority: P2
- **Setup:** Trigger each.
- **Viewport:** 1440x900.
- **Capture:** Three shots.
- **Variants to shoot:** 404 / network-drop-toast / 401-banner.
- **Bundle as:** `V-40-error-states/`.
- **Send-to-Claude prompt:** "PRism three error surfaces. Evaluate: consistency of error voice, Retry/Reauthenticate prominence, copy distinguishing user-action vs environmental. **Out of scope:** error taxonomy; choice of toasts vs banners vs full-page. Look for: errors reading identically, retry actions not obvious."

## V-41. PR-detail loading skeleton + transient mount states — Priority: P2
- **Setup:** Multi-file PR; throttle to Fast 3G in DevTools.
- **Viewport:** 1440x900.
- **Capture:** Sequence of 3.
- **Variants to shoot:** skeleton-initial / skeleton-mid / fully-mounted.
- **Bundle as:** `V-41-loading-skeleton/`.
- **Send-to-Claude prompt:** "PRism PR-detail mount: initial-click → mid-mount → fully-mounted with throttle. Evaluate: skeleton branding match to LoadingScreen (V-34); progress communication; transition smoothness. **Out of scope:** existence of skeleton vs alternate indicator. Look for: skeleton feeling like broken empty state, shape mismatch causing layout shift on swap, missing skeleton on panels >150ms."

## V-42. Motion — banner arrival, toast in/out, cheatsheet fade — Priority: P3
- **Setup:** Three sub-scenarios with DevTools animation throttling.
- **Viewport:** 1440x900.
- **Capture:** Nine shots (three per sub-scenario).
- **Variants to shoot:** banner-pre / banner-mid / banner-settled / toast-entry / toast-settled / toast-exit / cheatsheet-fade-in / cheatsheet-settled / cheatsheet-fade-out.
- **Bundle as:** `V-42-motion/`.
- **Send-to-Claude prompt:** "PRism three motion sequences as before/during/after triplets. Evaluate: banner arrival without attention-flight; toasts feeling deliberate; cheatsheet feeling like floating overlay. Banner must not cause layout shift (V-30/J-P0-07). **Out of scope:** specific easings/timings; existence of motion. Look for: motion violating 'banner-not-mutation' tone, toasts feeling like notifications-from-elsewhere, cheatsheet fade so fast user misses change."

## V-43. CommitMultiSelectPicker — 1-commit PR fallback — Priority: P3
- **Setup:** Sandbox `single-commit` fixture.
- **Viewport:** 1440x900.
- **Capture:** Single shot of Files tab + crop of picker.
- **Variants to shoot:** picker-in-context / picker-detail.
- **Bundle as:** `V-43-commit-multiselect/`.
- **Send-to-Claude prompt:** "PRism CommitMultiSelectPicker — replaces iteration tab strip on 1-commit PRs. Two shots: in Files tab context; closer crop. Evaluate: deliberate alternative vs degraded version; selection affordance; commit metadata readability. **Out of scope (spec-mandated):** fallback existence and trigger conditions; picker position. Look for: picker not communicating replacement role; commit rows looking stacked rather than selectable; multi-select affordance not obvious."

## V-44. Interaction states — hover, active, disabled across key controls — Priority: P2
- **Setup:** DevTools pseudo-class lock on: verdict picker, Submit (enabled + disabled), draft action cluster, Compare dropdowns, tree chevron.
- **Viewport:** 1440x900, cropped per control.
- **Capture:** Eight shots minimum.
- **Variants to shoot:** verdict-rest / verdict-hover / submit-enabled / submit-disabled-tooltip / draft-action-rest / draft-action-hover / compare-rest / compare-hover / tree-chevron-rest / tree-chevron-hover.
- **Bundle as:** `V-44-interaction-states/`.
- **Send-to-Claude prompt:** "PRism key controls in resting + hover/disabled states (DevTools-locked). Evaluate: hover signals interactivity without noise; disabled state reads 'not now' not 'broken' (especially Submit which spends much time disabled); active feedback deliberate. Cross-reference V-25 (disabled-Submit-with-tooltip specifically). **Out of scope:** choice of hover vs no-hover (UI ships with hover); cursor changes (browser-default). Look for: controls missing hover entirely; disabled not visually different from enabled; active feedback invisible."

---

# Part 6 — Appendix

## Fixture implementation

The validation suite's setup script (`e2e-validation/scripts/setup-fixtures.ts`) creates all fixtures from scratch on `prpande/prism-validation-sandbox`. Each fixture needs a distinct mutation pattern:

| Fixture | gh CLI / API endpoints | Constraints |
|---|---|---|
| `happy-path` | `gh pr create` from a feature branch; commits via `createCommitOnBranch` GraphQL mutation | None special |
| `foreign-pending-review` | Create `happy-path` then `gh api graphql -f query='mutation { addPullRequestReview(input: { pullRequestId: $id, body: $body }) { ... } }'` (no `event` → stays pending) | Pre-existing pending review must be reset between scenarios via `gh api graphql ... deletePullRequestReview` in beforeEach |
| `stale-commit-oid` | `happy-path` + a helper that advances the branch HEAD via `gh api -X PATCH /repos/.../git/refs/heads/<branch>` between submit attempts | Race-condition timing matters; the helper coordinates with the spec |
| `multi-iteration` | Create 4+ commits spaced ≥900s apart by manipulating commit `committerDate` via `gh api graphql createCommitOnBranch` (which accepts a timestamp). **MUST respect** the `IterationClustering.MinimumBoundaryGapSeconds = 900` constraint; commits within 15 min of each other land in one iteration bucket and the fixture fails silently | Per-commit timestamp must be set explicitly; do NOT rely on wall-clock waits |
| `single-commit` | One commit via `gh api graphql createCommitOnBranch` + `gh pr create` | Trivial |
| `markdown-with-mermaid` | Single commit adding a `.md` file with `\`\`\`mermaid` block + GFM table + code fence | Content is canned in the script |
| `comment-heavy` | `happy-path` + multiple `gh api graphql addPullRequestReviewThread` cycles followed by `submitPullRequestReview` (a pending review's threads only become real threads when finalized). At least one line gets multiple threads (multi-stack) | Needs full review cycle to finalize threads; ≥2 distinct review submissions to set up multi-stack on one line |
| `force-push` | Create a branch, push a commit, then `gh api -X PATCH /repos/.../git/refs/heads/<branch> -f force=true -f sha=<new-sha>`. `HeadRefForcePushedEvent` appears in PR timeline | Cannot use `createCommitOnBranch`'s `expectedHeadOid` validation (which rejects force-push) |
| `closed-pr-workflow` | Not a fixture; per-scenario workflow using `happy-path` + `gh pr close` / `gh pr reopen` | See [Sandbox hygiene contract](#sandbox-hygiene-contract) — close-reopen accumulates timeline events |
| `throwaway-pr` | Per-scenario `gh pr create` + teardown `gh pr close` + `gh api -X DELETE /repos/.../git/refs/heads/<branch>` | Spec owns teardown; ensure teardown runs in `afterEach` even on test failure |

<a id="sandbox-hygiene-contract"></a>
## Sandbox hygiene contract

The validation sandbox repo `prpande/prism-validation-sandbox` accumulates state across runs. Per the explicit lesson learned from the existing `prpande/prism-sandbox` history (per-fixture drift produced multiple "third drift-repair recreation" cycles), the validation suite must own its hygiene from day one.

**Per-scenario reset.** Scenarios that mutate sandbox state are responsible for restoring it in their teardown. `e2e-validation/helpers/reset-fixture.ts` provides:

- `resetFixture(fixtureName)` — calls `POST /test/clear-pr-session` for PRism-side state + applies the fixture-specific GitHub-side reset (e.g., delete any orphan pending reviews on the fixture's PR; restore branch HEAD to the canonical fixture commit; close any opened-by-test PRs).
- Per-fixture reset operations are encoded as data in `e2e-validation/scripts/fixture-reset-ops.json` so they can be audited and extended.

**Per-pass health check.** The orchestrator (SP2) runs `npm run validate-sandbox-health` before any pass. This script checks:
- Sandbox repo exists and is accessible.
- `fixtures.json` is present and matches the expected fixture set.
- For each fixture: the PR exists and is in the expected state (open vs closed; HEAD matches canonical).
- Aborts the pass with a clear error if anything is poisoned.

**Periodic full reset.** Every ~30 validation runs (or when sandbox health check fails), run `npm run reset-sandbox` to delete all fixture branches/PRs and re-create them from scratch. This is a destructive operation; budget ~5 minutes.

**API rate limits.** A Comprehensive pass (37 scenarios) writes 50-150 API calls per pass plus PRism's background polling (~2 calls/sec for the active-PR poll). Comprehensive passes may approach GitHub's authenticated REST API ceiling (5000/hour) and the GraphQL secondary rate limit. If 429 responses appear:
- Wait until the `X-RateLimit-Reset` epoch + 1 minute.
- Re-run the failing scenarios.
- Consider using a dedicated PAT for validation (don't share with other tooling).

The PATs used by Recipe B (primary), Recipe C (secondary), and Recipe E (destructive) should all be validation-dedicated. Sharing with daily-driver use risks rate-limit collision and 429s mid-pass.

<a id="pass-ordering-constraints"></a>
## Pass ordering constraints

Most scenarios are order-independent and can run in parallel (subject to the suite's `playwright.config.ts` `workers` setting — default 1 for hermetic dataDir safety). Exceptions:

- **J-P2-11 (token expiry)** MUST be the last scenario in any pass that includes it. It revokes its Recipe E PAT and breaks any subsequent scenario relying on `gh auth`. The spec is tagged `@destructive @last-in-pass`; the orchestrator (SP2) enforces this ordering by running tagged scenarios last.
- **J-P1-06 (PR reopen)** depends on J-P1-05 (PR close) having run first AND not having executed J-P1-05's discard step. If a partial-pass runs J-P1-06 without J-P1-05, the spec self-sets up by closing then reopening within the same scenario.
- **J-P0-03 (draft persistence across restart)** preserves the hermetic dataDir across the stop/relaunch. The launcher's `webServer` block must not delete the dataDir between scenarios when J-P0-03 is in flight.

<a id="out-of-scope"></a>
## Out of scope

Behaviors considered for the validation suite but excluded:

### Scenarios structurally impossible without internal faking/hooks

| Scenario | Why excluded | Where covered |
|---|---|---|
| Per-pipeline-step failure injection at granular granularity | Requires `FakeReviewSubmitter` with `methodName` + `afterEffect` knobs | Existing CI `frontend/e2e/s5-submit-retry-from-each-step.spec.ts` |
| Deterministic multi-tab simultaneous submit timing | Requires `/test/submit/hold` for precise timing | Existing CI `frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts` |
| Deterministic layout-shift-on-banner assertion | Requires `/test/emit-pr-updated` to skip 30s poll | Existing CI `frontend/e2e/no-layout-shift-on-banner.spec.ts` |
| Lost-response adoption (mutation succeeded server-side but local persist failed mid-millisecond) | Reproducible via `injectRealFailure` afterEffect=true but the timing is inherently non-deterministic on real network — promote to validation suite only if real-flow CI proves it stable | Existing real-flow `frontend/e2e/real/s5-real-lost-response-adoption.spec.ts` |
| TOCTOU foreign-pending-review state change during modal | Requires precise timing across two clients | Backend tests in `tests/PRism.Core.Tests/SubmitPipeline/` |

### Algorithm verification (unit-test territory)

| Surface | Why excluded | Where covered |
|---|---|---|
| Each of 9 reconciliation matrix branches | Pure-function algorithm | `tests/PRism.Core.Tests/Reconciliation/MatrixTests.cs` |
| Iteration clustering coefficients + edge cases | Pure algorithm | `tests/PRism.Core.Tests/IterationClustering/` |
| Each of 8 state-schema migration steps | Per-version migration is pure | `tests/PRism.Core.Tests/State/Migrations/` |
| Whitespace allow-list extensions | Table-test territory | Backend allow-list tests |
| 401 disambiguation probe branches | Pure logic | Backend tests |

### OS-level UX (manual visual check only, no automation possible)

| Surface | Why excluded |
|---|---|
| Windows SmartScreen first-run dialog | OS-level UX outside Playwright's reach; manual visual check only |
| macOS Gatekeeper first-run dialog | Same |
| macOS Keychain "Always Allow" prompt | Same |
| Screen reader (VoiceOver / NVDA) walks | Requires actual screen-reader tools; manual session only |

## Glossary

| Term | Definition |
|---|---|
| **Verdict** | One of Approve / Request changes / Comment — chosen in the verdict picker, finalized on submit |
| **Iteration** | A reconstructed grouping of commits inferred from the PR timeline; tabs are "All changes" + per-iteration tabs |
| **Compare picker** | Two-dropdown selector for diffing arbitrary iteration pairs; auto-swaps reverse selections |
| **Draft (DraftComment)** | A new inline comment thread the user has authored locally but not submitted |
| **Reply (DraftReply)** | A reply to an existing thread, authored locally, attaches to the pending review on submit |
| **Pending review** | GitHub-side review object (`PRR_...`) that holds threads/replies invisibly until `submitPullRequestReview` finalizes it |
| **Reconciliation pass** | The classification algorithm that runs on Reload, sorting drafts into Fresh / Moved / Stale buckets |
| **Foreign pending review** | A pending review that exists on github.com but whose ID doesn't match the local `pendingReviewId` |
| **Identity change** | The Replace-token flow detecting that the new PAT authenticates as a different GitHub login than the previous one |
| **Cross-tab stamp (V6)** | The per-tab `TabStamps` map (state schema version 6) that gates redundant cross-tab echoes via BroadcastChannel |
| **AI preview** | The `ui.aiPreview` flag-driven mode where AI capability flags return `true` and slots render canned placeholder data |
| **`<dataDir>`** | PRism's data directory. Production: `%LOCALAPPDATA%\PRism` / `~/Library/Application Support/PRism`. Validation suite: per-run temp dir managed by the suite's `webServer` block |
| **Wedge** | The combination of features that motivates opening PRism instead of github.com — iteration tabs, file-by-file diff, stale-draft reconciliation, local-first authoring |
| **Recipe A/B/C/D/E** | Pre-condition setup procedures defined in the recipes section |
| **`injectRealFailure`** | The validation suite's helper that intercepts the response of a real GitHub HTTP call to simulate transient conditions. Calls `/test/real-inject/inject-failure` (Test-env setup endpoint) via raw fetch |
| **Validation sandbox** | `prpande/prism-validation-sandbox` — the live mutable GitHub repo owned by the validation suite. Separate from `prpande/prism-sandbox` (real-flow CI suite's). |

<a id="future-stages"></a>
## Future stages

The validation suite is broken into three sub-projects:

### SP1 (THIS spec) — Validation suite + helpers + fixtures + Playwright specs

**Scope:** Set up the `e2e-validation/` directory tree end-to-end:
- Bootstrap `package.json`, `tsconfig.json`, `playwright.config.ts`, `node_modules/`.
- Create the `prpande/prism-validation-sandbox` repo (one-time manual step documented in Recipe D).
- Write `e2e-validation/scripts/setup-fixtures.ts` that creates all 8 fixtures per [Appendix § Fixture implementation](#fixture-implementation).
- Write `e2e-validation/helpers/` — `reset-fixture.ts`, `inject-real-failure.ts`, `gh-sandbox.ts`, `recipes.ts`, `reconciliation-fixtures.ts`, fixture types. All owned, no shared imports.
- Write `e2e-validation/scripts/reset-sandbox.ts` (full destructive reset) + `e2e-validation/scripts/sandbox-health.ts` (per-pass health check).
- Write 44 Playwright specs at `e2e-validation/specs/j-*.spec.ts`, each runnable end-to-end.

**Acceptance:** From a fresh checkout, a single Claude Code session can:
1. `cd e2e-validation && npm install` succeeds.
2. `gh auth login --scopes repo` + `npm run setup-fixtures` succeeds against `prpande/prism-validation-sandbox`.
3. `npx playwright test --grep @P0` runs all 8 P0 scenarios and produces standard Playwright JSON output.

### SP2 — Orchestrator + reporting

**Scope:** Wrap the validation suite in a single command (`npm run validate-experience`) that:
- Runs scenarios by priority filter (`--priority P0,P1`).
- Enforces ordering constraints (J-P2-11 last; J-P1-06 self-sets-up).
- Captures Playwright's JSON output.
- Writes a unified per-pass report to `e2e-validation/reports/YYYY-MM-DD-HHMMSS.{json,md}`.
- Maintains `e2e-validation/reports/_last-pass-by-case.json` for cross-run risk tracking.
- Runs the sandbox health check first; aborts if poisoned.

**Resumption prompt:**

> I want to brainstorm SP2 of the validation suite work: the orchestrator. The validation suite spec lives at `docs/specs/2026-05-28-manual-validation-test-plan-design.md`. The suite directory is `e2e-validation/` with 44 Playwright specs already implemented per SP1. SP2 wraps `npx playwright test` (from `e2e-validation/`) with priority filtering (`--grep @P0,@P1`), ordering enforcement (`@last-in-pass` tagged scenarios run last), JSON output capture, and Markdown report derivation. Output: `e2e-validation/reports/YYYY-MM-DD-HHMMSS.{json,md}`. Plus `_last-pass-by-case.json` for cross-run tracking. Pre-pass sandbox health check via `npm run validate-sandbox-health`. CLI: `npm run validate-experience [-- --priority P0,P1]`. Sequential execution. Failure recovery: don't fail-fast; capture partials. No CI integration (local-only). The orchestrator lives at `e2e-validation/scripts/run-validation.ts` to maintain the suite's isolation contract.

### SP3 — Claude-driven visual loop (later, pilot-flagged)

**Scope:** Extend the orchestrator with `--with-visual` flag that runs V-1..V-44 capture specs, bundles screenshots per V-case, dispatches them in 5 thematic batches to Claude subagents via `claude -p` CLI subprocess, merges findings into the same result file. Pilot-flagged: default off; first run surfaces a warning to evaluate findings quality before trusting output. Pilot strategy: run V-1 first; if findings are useful, proceed; if not, revise prompt template or remove Part 5.

**Resumption prompt:**

> I want to brainstorm SP3 of the validation suite work: the Claude-driven visual review loop. The validation suite spec at `docs/specs/2026-05-28-manual-validation-test-plan-design.md` defines V-1..V-44 capture cases in Part 5 with canned Send-to-Claude prompts. SP1 (suite + specs) and SP2 (orchestrator) are shipped. SP3 extends the orchestrator with `--with-visual` flag. Architecture: Playwright capture specs in `e2e-validation/specs/visual/` → bundle PNGs per V-case → group into 5 thematic batches (V-1..V-7 Setup+Inbox; V-8..V-18 PR-detail+Files; V-19..V-23 Markdown+Composer; V-24..V-32 Reconcile+Submit; V-33..V-44 Polish+a11y+Errors) → dispatch each batch via `claude -p` CLI subprocess with per-V prompts + screenshot paths → parse findings → merge into validation result file. Pilot-flagged: default off; first run surfaces "validate V-1 first" warning. The visual loop's workflow is explicitly marked unvalidated in the spec.
