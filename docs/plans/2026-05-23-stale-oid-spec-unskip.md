# Stale-OID Real-Flow Spec — Un-skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un-skip `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` so the suite exercises the full stale-commit-OID recreate pipeline end-to-end against `prpande/prism-sandbox` PR #7 — driving the missing stale-draft override step that PR #65's banner fix exposed.

**Architecture:**

- The Reload-banner non-surfacing has already been fixed (PR #65 — `SseEventProjection.Project` now projects `pr-updated` to the string-`prRef` wire shape). The spec's first ~110 lines work as-is on a live sandbox.
- The remaining blocker (finding doc out-of-band #7) is the second-submit choreography. After `advanceHead`, the inline draft created earlier (anchored to `baseOid` line 3 with `anchoredLineContent="{"`) is classified `stale` because the new commit's line 3 has a different content. `SubmitButton.tsx:61-64` correctly disables Submit with the tooltip _"Resolve or override the stale drafts in the Drafts tab first."_ The spec's `await page.getByRole('button', { name: /^submit review$/i }).click()` then no-ops (the button has `onClick={undefined}` when disabled). (The early-iteration `advanceHead` content also deleted line 3 entirely, which broke the downstream recreate Attach on real GitHub — newContent was later rewritten to preserve line 3's position; see the spec's inline rationale block above `advanceHead`.)
- The user-visible affordance to override is the **"Keep anyway"** button on `UnresolvedPanel` (`frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx` + `StaleDraftRow.tsx:131-138`). It auto-renders above the tabs whenever any draft has `status === 'stale' && !isOverriddenStale`. Click it → fires `PUT /draft { overrideStale: { id } }` → server flips `IsOverriddenStale=true` → next session refetch removes the stale from the SubmitButton gate.
- The deterministic wait pattern is already established by `frontend/e2e/s4-keep-anyway-survives-reload.spec.ts:62-70`: set up a `page.waitForResponse` promise for the PUT-200 _before_ clicking Keep anyway, then `await` it. Mirror that pattern here, scoped to the post-reload phase so we don't accidentally re-match the original `/draft` PUT from line 57-58.
- The second remaining issue (finding out-of-band #3) is that the spec has no `test.setTimeout()` and Playwright defaults to 30 s — well below the ~150 s of internal waits plus live-GitHub latency. Add `test.setTimeout(300_000)` at the top of the test body. Internal per-assertion timeouts are already bounded (15 s / 30 s / 20 s / 10 s), so a stuck assertion will surface fast; the 5-min wrapper exists only to keep wall-clock real-GitHub latency from hitting the default ceiling.

**Tech Stack:** TypeScript / Playwright (`@playwright/test`) / live GitHub REST + GraphQL via `gh` CLI / `prpande/prism-sandbox` PR #7.

**Scope:** One spec file + four doc edits. No production code change. The four hypotheses the original deferral entry enumerated (item 1 GitHub PR propagation lag; item 2 `BannerRefresh` empty-render; the spec's H1–H4) are all already disposed of by the finding doc and PR #65. This plan is purely (a) drive the override gate, (b) bump the wrapper timeout, (c) flip the skip, (d) refresh the doc references.

---

## File Structure

| File                                                    | Action | What it owns                                                                                                                         |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`    | Modify | Rewrite header comment, add wrapper timeout, flip `test.skip` → `test`, insert override-step block between reload and second submit. |
| `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md` | Modify | PARTIALLY RESOLVED entry at line 944 → RESOLVED with new PR/commit citation.                                                         |
| `docs/e2e/real-flow.md`                                 | Modify | Four references claim spec is `test.skip`-ed (lines 37, 46, 57, 61). Update to reflect 4-active-specs reality.                       |
| _(no source code changes)_                              | —      | PR #65 already shipped the only production fix this spec needed.                                                                     |

---

## Task 1: Bump test wrapper timeout

**Files:**

- Modify: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts:39-46`

- [ ] **Step 1: Add `test.setTimeout(300_000)` as the first statement in the test body**

The test currently starts:

```ts
test.skip('S5 real flow — stale commit OID triggers recreate on second submit (deferred — see docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md)', async ({
  page,
}) => {
  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}`);
```

Change to (note: still `test.skip` at this task — flipping happens in Task 4 after the override-step is in place):

```ts
test.skip('S5 real flow — stale commit OID triggers recreate on second submit (deferred — see docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md)', async ({
  page,
}) => {
  // Wrapper timeout: internal waits sum to ~150 s and each is independently bounded
  // (so a real stall fails fast at its own assertion). The 5-min ceiling exists only
  // so live-GitHub latency under load can't trip Playwright's 30 s default.
  test.setTimeout(300_000);

  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}`);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean (or unchanged from baseline).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/real/s5-real-stale-commit-oid.spec.ts
git commit -m "test(s5-real-stale-oid): add 5-min wrapper timeout (out-of-band #3)"
```

---

## Task 2: Insert the override-stale step between reload and second submit

**Files:**

- Modify: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts:107-117`

**Why this lives between mark-viewed and the second submit:**

- The post-reload `mark-viewed` 204 wait (current line 107-109) guarantees the page has fully re-hydrated against the new head and the session reflects the now-stale draft.
- `UnresolvedPanel` is mounted at the `PrDetailPage` level (`frontend/src/pages/PrDetailPage.tsx:173`) — above the tab strip — so it's visible regardless of which tab the user happens to be on. No tab navigation needed.
- The Keep-anyway click fires `PUT /pr/<owner>/<repo>/<n>/draft` with `{ overrideStale: { id } }`. The same URL pattern is reused for ALL draft mutations, so the wait predicate must be set up _after_ the earlier `draft` PUT from line 57-58 has already resolved — which it has, because that earlier wait is `await`ed and the awaited `injectRealFailure` + `submit` cycle + dialog tear-down all complete before we get here.

- [ ] **Step 1: Identify the insertion point**

Current spec (lines 102-117):

```ts
// Wait for the Reload banner to appear (driven by SSE pr-updated; ActivePrPoller cadence 1s + replica propagation).
const reloadBanner = page.getByRole("button", { name: /reload pr|reload/i });
await expect(reloadBanner).toBeVisible({ timeout: 30_000 });
await reloadBanner.click();
// After reload, mark-viewed re-stamps LastViewedHeadSha=newOid.
await page.waitForResponse(
  (r) => r.url().endsWith("/mark-viewed") && r.status() === 204,
  {
    timeout: 15_000,
  },
);

// Second submit. Pipeline: FindOwnPendingReviewAsync finds review at baseOid;
// session.PendingReviewId matches → own; pending.CommitOid != newOid → stale → recreate.
// First Confirm Submit triggers StaleCommitOidRecreating (server-side orphan delete + clear stamps);
// dialog transitions to kind='stale-commit-oid' and renders StaleCommitOidBanner. The user must
// then click "Recreate and resubmit" — that's the user-consent gate for the resubmit cycle
// (see SubmitDialog.tsx:192-205, StaleCommitOidBanner.tsx:53, useSubmit.ts:144-152).
await page.getByRole("button", { name: /^submit review$/i }).click();
```

The override block goes between the closing `})` of the mark-viewed wait and the `// Second submit.` comment.

- [ ] **Step 2: Insert the override block**

Insert immediately after the `mark-viewed` 204 wait (so the comment block above `// Second submit.` stays unchanged):

```ts
// The draft created earlier (line 57-58) anchored to baseOid; after advanceHead it
// classifies stale and SubmitButton disables until the user overrides or discards
// (SubmitButton.tsx:61-64 — "Resolve or override the stale drafts in the Drafts tab first.").
// The override affordance is "Keep anyway" on UnresolvedPanel (StaleDraftRow.tsx:131-138),
// which mounts above the tabs whenever any draft is stale-not-overridden.
//
// Two deterministic waits bracket the click so the test never races React state:
//  - BEFORE: assert on the Keep-anyway button itself (not just panel visibility — the
//    panel also renders for `needsReconfirm` or `movedCount > 0` per UnresolvedPanel.tsx:74,
//    so panel-visible alone is not proof that our stale row is mounted).
//  - AFTER: assert the panel hides. StaleDraftRow.handleKeepAnyway fires the PUT, then
//    onMutated() → draftSession.refetch() runs a follow-up GET. The panel only disappears
//    once the refetch lands and React re-renders — which is the same tick that flips
//    SubmitButton's stale gate in SubmitButton.tsx:61-64. Asserting on disappearance
//    avoids a Playwright actionability wait on the still-disabled Submit button below.
// Mirrors frontend/e2e/s4-keep-anyway-survives-reload.spec.ts:62-70 for the PUT wait pattern.
const unresolvedPanel = page.getByRole("region", {
  name: /unresolved drafts/i,
});
const keepAnywayBtn = unresolvedPanel.getByRole("button", {
  name: /keep anyway/i,
});
await expect(keepAnywayBtn).toBeVisible({ timeout: 15_000 });
const overridePromise = page.waitForResponse(
  (r) =>
    r
      .url()
      .endsWith(
        `/api/pr/prpande/prism-sandbox/${staleFixture.prNumber}/draft`,
      ) &&
    r.request().method() === "PUT" &&
    r.status() === 200,
  { timeout: 10_000 },
);
await keepAnywayBtn.click();
await overridePromise;
await expect(unresolvedPanel).not.toBeVisible({ timeout: 10_000 });
```

(Note the blank line at the end so the spacing before `// Second submit.` matches the rest of the file.)

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/real/s5-real-stale-commit-oid.spec.ts
git commit -m "test(s5-real-stale-oid): drive Keep-anyway override before second submit (out-of-band #7)"
```

---

## Task 3: Refresh the file header comment

**Files:**

- Modify: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts:1-14`

- [ ] **Step 1: Replace lines 1-14 with a forward-looking docstring**

The current header (lines 1-13) explains why the spec is skipped. After un-skipping, replace it with a brief description of what the spec exercises. Lines 14 onward stay untouched.

Current:

```ts
// STILL SKIPPED — but the banner root cause is now fixed.
//
// The Reload-banner non-surfacing was investigated and resolved: it was a `pr-updated`
// SSE wire-contract mismatch (the backend shipped `prRef` as an object; the frontend
// handler dropped every event). Fixed in the same PR — see
// docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md.
//
// This spec stays `test.skip`-ed for a SEPARATE reason: its second-submit choreography
// (below) clicks "Submit review" directly, but after `advanceHead` the draft is stale
// and SubmitButton disables until the stale draft is overridden in the Drafts tab. The
// second-submit portion needs rewriting to drive that override gate before un-skipping.
// See the finding's out-of-band #7. Un-skipping also needs a `test.setTimeout()` bump
// (out-of-band #3) — the suite's internal waits exceed Playwright's 30s default.
import { test, expect, request } from "@playwright/test";
```

Replace with:

```ts
// S5 real flow — stale commit OID triggers recreate on second submit.
//
// Exercises the full stale-recreate pipeline on a live sandbox PR:
//  1) Draft an inline comment anchored to baseOid.
//  2) Submit with AttachThread pre-effect injection → Begin lands a pending review at
//     baseOid, AttachThread fails → dialog Failed → Cancel.
//  3) Push a new commit via createCommitOnBranch (advanceHead).
//  4) Wait for the Reload banner (SSE pr-updated; PR #65 wire fix).
//  5) Click Reload → mark-viewed re-stamps LastViewedHeadSha=newOid.
//  6) The previously-saved draft is now stale (anchor line dropped by step 3). Override it
//     via UnresolvedPanel "Keep anyway" so SubmitButton's stale gate clears
//     (SubmitButton.tsx:61-64; UnresolvedPanel + StaleDraftRow.tsx).
//  7) Submit again → FindOwnPendingReviewAsync finds the pending review at baseOid,
//     detects stale (pending.CommitOid != newOid) → user consents via Recreate and
//     Resubmit → fresh Begin→Attach→Finalize at newOid → "Review submitted".
//  8) GitHub-side: exactly one finalized review at newOid (not baseOid); no own pending.
//
// History: this spec uncovered the pr-updated SSE wire-contract bug fixed in PR #65 — see
// docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md.
import { test, expect, request } from "@playwright/test";
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/real/s5-real-stale-commit-oid.spec.ts
git commit -m "test(s5-real-stale-oid): rewrite header docstring for un-skipped state"
```

---

## Task 4: Flip `test.skip` → `test`

**Files:**

- Modify: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts:39`

- [ ] **Step 1: Flip the call and drop the "deferred" tail**

Change:

```ts
test.skip('S5 real flow — stale commit OID triggers recreate on second submit (deferred — see docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md)', async ({
```

To:

```ts
test('S5 real flow — stale commit OID triggers recreate on second submit', async ({
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/real/s5-real-stale-commit-oid.spec.ts
git commit -m "test(s5-real-stale-oid): un-skip (closes deferral)"
```

---

## Task 5: Environment prep + first run

**Files:**

- _(no edits — execution-only verification step)_

- [ ] **Step 1: Confirm gh auth + scopes**

Run: `gh auth status`
Expected: shows authenticated user `prpande` with scopes including `repo` and `read:org`. If missing scopes, run `gh auth refresh -s repo,read:org`.

- [ ] **Step 2: Regenerate fixtures.json**

Run: `cd frontend && npm run setup-real-e2e-fixtures`
Expected: console reports 4 fixtures present (happy, foreign, lost-response, stale-oid) and writes `frontend/e2e/real/fixtures.json`. The script is idempotent — re-running with existing branches/PRs is a no-op per `docs/e2e/real-flow.md:23`.

- [ ] **Step 3: Verify stale-oid fixture is PR #7**

Run: `cd frontend && node -e "const f = require('./e2e/real/fixtures.json'); const s = f.find(x => x.name === 'stale-oid'); console.log(s.prNumber, s.baseOid, s.anchorFile, s.anchorLine);"`
Expected: prints `7 <40-char-sha> src/Calc.cs 3` (line 3 is the seeded anchor in `setup-real-e2e-fixtures.ts`).

If `prNumber` is not 7, the sandbox fixture has drifted or been recreated again. Confirm via `gh pr list --repo prpande/prism-sandbox --head e2e-real-stale-oid-fixture-prpande --state open` that the branch has an active PR. Repair per `docs/e2e/real-flow.md:23` if needed (the historical drift-repair sequence was PR #5 → #6 → #7).

- [ ] **Step 4: Single-spec smoke run**

Run from the worktree root:

```powershell
cd frontend
npx playwright test --config=playwright.real.config.ts s5-real-stale-commit-oid
```

Expected: 1 passed (one test, one project `real`). Wall-clock typically 60-120s including the `webServer` boot (`npm run build && dotnet run`). If the run fails, capture the `<DataDir>` line from stdout (`[real-flow] DataDir=...`) and review `<DataDir>/logs/prism-2026-05-23.log` — the on-disk logger is force-enabled by `PRISM_FILE_LOGGER_FORCE=1` per `playwright.real.config.ts:42`.

- [ ] **Step 5: No commit**

This task is verification-only; nothing to commit.

---

## Task 6: 3× consecutive passing runs (pre-merge gate per design § 8.2)

**Files:**

- _(no edits — verification-only)_

- [ ] **Step 1: Run the spec three times in a row**

```powershell
cd frontend
npx playwright test --config=playwright.real.config.ts s5-real-stale-commit-oid; if ($LASTEXITCODE -eq 0) { npx playwright test --config=playwright.real.config.ts s5-real-stale-commit-oid; if ($LASTEXITCODE -eq 0) { npx playwright test --config=playwright.real.config.ts s5-real-stale-commit-oid } }
```

Expected: three sequential `1 passed`. PowerShell `if` chain short-circuits — if any run fails, the chain stops and the remaining runs don't fire.

- [ ] **Step 2: If any run fails**

- Capture the `[real-flow] DataDir=...` line from that run's stdout.
- Read `<DataDir>/logs/prism-2026-05-23.log` and `frontend/test-results/<test-name>/trace.zip`.
- If the failure is a transient GitHub 5xx or rate-limit edge per `docs/e2e/real-flow.md:62`, it does NOT count toward the 3-run gate; just re-run — `resetSandboxFixture` runs in `beforeEach` (it calls `forceResetBranch` with `force=true` against `fixture.baseOid` per `frontend/e2e/real/helpers/{reset-sandbox-fixture.ts:21,gh-sandbox.ts:193-209}`), so every consecutive run starts at the same SHA. No manual recovery needed.
- If the failure reproduces, treat as a real bug — DO NOT proceed to PR. Diagnose, plan a fix, and update this plan.

- [ ] **Step 3: Full real-flow suite once at the end**

```powershell
cd frontend
npm run test:e2e:real
```

Expected: 4 passed (happy, foreign, lost-response, stale-oid). This is the suite-level proof that un-skipping didn't break the other three.

- [ ] **Step 4: No commit**

Verification-only.

---

## Task 7: Update real-flow doc

**Files:**

- Modify: `docs/e2e/real-flow.md:37` `docs/e2e/real-flow.md:46` `docs/e2e/real-flow.md:57` `docs/e2e/real-flow.md:61`

- [ ] **Step 1: Update spec-count line at line 37**

Current:

```
Wall-clock ~3-5 minutes for the suite (3 active specs; the stale-oid spec is currently `test.skip`ed pending the deferral — see below). `retries: 0` is intentional — see "Known flake surfaces" below.
```

New:

```
Wall-clock ~5-8 minutes for the suite (4 active specs; the stale-oid spec adds a real `advanceHead` + Reload-banner + stale-recreate cycle that runs longer than the other three). `retries: 0` is intentional — see "Known flake surfaces" below.
```

- [ ] **Step 2: Update spec table row at line 46**

Current:

```
| `s5-real-stale-commit-oid` _(deferred — `test.skip`)_ | `addPullRequestReview` at a non-head OID; `deletePullRequestReview` orphan cleanup; full stale-recreation pipeline against real GraphQL. **See [s5 deferrals doc](../specs/2026-05-11-s5-submit-pipeline-deferrals.md) — section "Real-flow stale-OID spec — SSE/Reload-banner non-surfacing after createCommitOnBranch".** |
```

New:

```
| `s5-real-stale-commit-oid` | `addPullRequestReview` at a non-head OID; `deletePullRequestReview` orphan cleanup; full stale-recreation pipeline against real GraphQL; SSE `pr-updated` wire-shape regression net (PR #65). |
```

- [ ] **Step 3: Update regression-net injection row at line 57**

Current:

```
| `s5-real-stale-commit-oid` _(spec skipped)_ | _(n/a while deferred — re-enable spec first; see deferrals doc)_ | _(n/a)_ |
```

New:

```
| `s5-real-stale-commit-oid` | Force `IsStaleCommitOid` to return `false` in the submit pipeline (or short-circuit it) so the second submit re-uses the pending review at `baseOid` | Final `reviews[0].commitOid === baseOid`, violating `expect(...).not.toBe(baseOid)` |
```

- [ ] **Step 4: Replace flake-surface entry at line 61**

Current:

```
- **Stale-OID spec, SSE-Reload-banner non-surfacing:** spec is currently `test.skip`ed pending root cause. Two hypotheses on file (GitHub PR record propagation lag, or BannerRefresh empty-render on first-poll-after-subscribe). See [deferrals doc](../specs/2026-05-11-s5-submit-pipeline-deferrals.md) for details.
```

New:

```
- **Stale-OID spec, fixture drift after interrupted run:** `advanceHead` has no post-run cleanup; an interrupted run + a regenerate of `fixtures.json` can leave `setup-real-e2e-fixtures` blessing the drifted tip as the new `baseOid`. Symptom: subsequent runs fail at "add comment on line N" because the seeded file no longer has line N. See out-of-band #2 in the investigation finding for the planned hardening; until then, `forceResetBranch` runs in `beforeEach` (so an in-place re-run is safe) and a full recreate of the branch + PR is the manual escape hatch.
```

- [ ] **Step 5: Commit**

```bash
git add docs/e2e/real-flow.md
git commit -m "docs(real-flow): un-skip stale-oid spec — update suite count, table, injection sketch, flake note"
```

---

## Task 8: Mark the deferral entry RESOLVED

**Files:**

- Modify: `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:959`

- [ ] **Step 1: Replace the PARTIALLY RESOLVED line**

Current (line 959):

```
- **PARTIALLY RESOLVED 2026-05-21:** the banner root cause was found and fixed. It was neither of the two causes above — it is a `pr-updated` SSE wire-contract mismatch (`SseChannel.OnActivePrUpdated` serialized the raw `ActivePrUpdated` record, shipping `prRef` as an object the frontend handler dropped). See `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md` and `docs/plans/2026-05-21-pr-updated-wire-fix.md`; the fix shipped in the finding PR. `s5-real-stale-commit-oid.spec.ts` stays `.skip`ed — un-skipping it is now blocked only on its stale second-submit choreography (finding out-of-band #7: the spec does not drive the intentional stale-draft override gate, `SubmitButton.tsx:61-64`), a separate follow-up.
```

New (replace as-is; commit-sha and PR-number placeholders are filled in Task 9 after the PR merges and the commit sha is known):

```
- **PARTIALLY RESOLVED 2026-05-21:** the banner root cause was found and fixed (PR #65, merge `619b31a7`). It was neither of the two causes above — it is a `pr-updated` SSE wire-contract mismatch (`SseChannel.OnActivePrUpdated` serialized the raw `ActivePrUpdated` record, shipping `prRef` as an object the frontend handler dropped). See `docs/specs/2026-05-19-stale-oid-banner-investigation-finding.md` and `docs/plans/2026-05-21-pr-updated-wire-fix.md`.
- **RESOLVED 2026-05-23:** un-skipped in PR #<TBD> (merge `<TBD>`). The remaining blocker — out-of-band #7's intentional stale-draft override gate — is now driven by the spec via the UnresolvedPanel "Keep anyway" button between the post-reload `mark-viewed` and the second submit. The wrapper timeout was also bumped per out-of-band #3 (`test.setTimeout(300_000)`). Plan: `docs/plans/2026-05-23-stale-oid-spec-unskip.md`. Pre-merge gate: 3 consecutive local passes against `prpande/prism-sandbox` PR #7, per stale-OID investigation design § 8.2.
```

- [ ] **Step 2: Commit**

```bash
git add docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md
git commit -m "docs(s5-deferrals): mark stale-OID spec un-skip RESOLVED (placeholders for PR # and merge sha)"
```

The PR # and merge sha get filled by an amend or follow-up commit once known (Task 9).

---

## Task 9: Pre-push checklist + open PR

**Files:**

- _(no edits in this task — workflow only)_

- [ ] **Step 1: Pre-push checklist (per `.ai/docs/development-process.md`)**

Run sequentially (each must be green before the next):

```powershell
cd frontend
npm run lint
npm run build
npm test
cd ..
dotnet build --configuration Release
dotnet test --no-build --configuration Release
```

Expected: all green. If any step fails, fix in place, commit, and re-run the failing step.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/stale-oid-unskip
```

- [ ] **Step 3: Open the PR via the standard skill**

Invoke `compound-engineering:ce-commit-push-pr` (or its commit-push-pr equivalent) to draft a value-first PR description. PR title suggestion: `test(real-flow): un-skip stale-OID spec — drive Keep-anyway override + bump wrapper timeout`.

The PR body should cover:

- **What:** Un-skips `s5-real-stale-commit-oid.spec.ts`; adds 5-min wrapper timeout; drives the Keep-anyway override step the existing spec was missing.
- **Why now:** PR #65 fixed the Reload-banner non-surfacing (the original deferral cause). The remaining blocker — out-of-band #7 — was a frontend gate the spec didn't drive; this PR drives it.
- **Pre-merge evidence:** "3 consecutive local passes against `prpande/prism-sandbox` PR #7" (paste the wall-clock per run from the local run logs).
- **Out of scope (explicit):** out-of-band #2 (fixture-drift hardening in `setup-real-e2e-fixtures`); on-disk-logger polish from PR #61/#63; S6 Settings page; any refactor of `SseEventProjection` or the just-shipped wire fix.
- **Risk:** the spec is local-only (`docs/e2e/real-flow.md` — not on CI). The change cannot affect CI green/red; the worst case is a spec that flakes against live GitHub for the next maintainer who runs `npm run test:e2e:real`.

- [ ] **Step 4: Address reviewer comments**

Use `pr-followup` (or `pr-autopilot` if you opened with autopilot) to loop on bot + human comments until quiescent + CI green.

- [ ] **Step 5: After merge, backfill the deferral entry with the real PR # and merge sha**

```bash
# On main, after merge:
git fetch origin
MERGE_SHA=$(git log origin/main -1 --format=%H)
# Edit docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md replacing <TBD> placeholders.
# Open a tiny follow-up PR or amend if not yet merged.
```

(Alternative: include the real PR # + sha in the final pre-merge force-push by amending Task 8's commit — the sha can be known if you set up the merge commit with a known parent via squash-merge with a predictable message. Cleanest is the small follow-up to avoid force-push.)

---

## Task 10: Worktree cleanup

**Files:**

- _(no edits — destructive cleanup only after merge)_

- [ ] **Step 1: Confirm PR is merged + main is up-to-date**

```bash
cd /d/src/PRism
git fetch origin
git checkout main
git pull origin main
git log -1 --format='%H %s'  # confirm the merge commit is present
```

- [ ] **Step 2: Remove the worktree + delete the local branch**

```bash
git worktree remove /d/src/prism-stale-oid-unskip
git branch -d feat/stale-oid-unskip
```

If `git branch -d` complains about unmerged commits, that's a signal something didn't actually land — diagnose before forcing.

- [ ] **Step 3: Confirm clean state**

```bash
git worktree list  # should NOT list prism-stale-oid-unskip
git branch         # should NOT list feat/stale-oid-unskip
```

---

## Self-Review

**Spec coverage:**

- ✅ Out-of-band #7 (stale-draft override gate) — Task 2 inserts the Keep-anyway click + PUT-200 wait, mirroring the s4 spec pattern.
- ✅ Out-of-band #3 (no `test.setTimeout()`) — Task 1 adds `test.setTimeout(300_000)`.
- ✅ Un-skip itself — Task 4 flips `test.skip` → `test`.
- ✅ Header comment refresh — Task 3.
- ✅ Deferral entry → RESOLVED — Task 8.
- ✅ Real-flow doc references — Task 7 (all four lines).
- ✅ Pre-merge gate (3× consecutive) — Task 6.
- ✅ Pre-push checklist — Task 9 Step 1.

**Placeholder scan:**

- `<TBD>` appears in Task 8 Step 1 _intentionally_ (PR # + merge sha aren't known yet); Task 9 Step 5 documents how to backfill them. Not a plan failure — explicitly tracked.
- No "TODO", "implement later", "appropriate error handling", "similar to Task N", or other placeholder anti-patterns.

**Type consistency:**

- The override-block uses `staleFixture.prNumber` (already typed in spec line 29).
- Selector patterns (`getByRole('region', { name: ... })`, `getByRole('button', { name: ... })`) match the s4 spec verbatim.
- All API URL patterns use the same `/api/pr/<owner>/<repo>/<number>/draft` shape as the existing line 57-58 wait.

**Explicit out-of-scope confirmation (per user prompt):**

- Out-of-band #2 (fixture-drift hardening) — Task 7 Step 4 only adds a flake-surface note; no code fix here.
- On-disk-logger polish (PR #61/#63 deferrals) — not touched.
- S6 Settings page — not touched.
- SSE projection / wire-fix refactor — not touched.
