# Issue-Resolution Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent-driven, proof-carrying, risk-gated issue-resolution workflow as a runbook plus its doc-wiring, and an optional advisory CI risk-classifier.

**Architecture:** The deliverable is documentation + config, not application code. Part A creates the agent-facing runbook (`.ai/docs/issue-resolution-workflow.md`) and wires it into every index the repo's doc-maintenance contract requires. Part B adds an *advisory* CI check (`risk-classification.yml`) whose classification logic is a pure, unit-tested Node module — the one piece of real logic in this plan. Enforcement is advisory + human-merge per the spec's resolved OPEN DECISION 2; nothing here blocks a merge.

**Tech Stack:** Markdown (`.ai/docs`, `.cursor/rules` `mdc:` includes); the advisory workflow runs on **`ubuntu-latest`** with default `bash` (pure-Node logic, no OS dependency); Node `node:test` (no new deps); `gh` CLI; local verification steps run under git-bash on the Windows worktree.

**Source spec:** [`docs/specs/2026-06-03-issue-resolution-workflow-design.md`](../specs/2026-06-03-issue-resolution-workflow-design.md) — authoritative for all rationale/prose. **Deferrals:** [`docs/specs/2026-06-03-issue-resolution-workflow-design-deferrals.md`](../specs/2026-06-03-issue-resolution-workflow-design-deferrals.md).

**Scope note (read before starting):** Part A is the workflow and is independently complete. Part B (the advisory CI classifier) is a *second* surfacing layer on top of the agent's own triage comment + label + the human merge that already surface risk. If you want the smallest shippable increment, ship Part A and treat Part B as a fast-follow. Do not start Part B until Part A is merged.

---

## File Structure

| File | Responsibility | Part |
|------|----------------|------|
| `.ai/docs/issue-resolution-workflow.md` | **The runbook.** Agent-facing, imperative operational rendering of the spec: the two-axis decision tree, the risk-surface table with concrete signals, the triage-comment / `## Proof` / notification templates, the per-tier pipelines, and the abort/escalation list. | A |
| `.ai/README.md` | Doc-index table — add the runbook row. | A |
| `.cursor/rules/issue-resolution.mdc` | New Cursor rule including the runbook via `mdc:` link, scoped to all files. | A |
| `.cursor/rules/README.md` | Cursor rule-table — add the new rule row. | A |
| `CLAUDE.md` | Add the runbook to the shared-rules link table **and** record the gate-substitution authorization (the override is in force once this lands). | A |
| `.ai/docs/documentation-maintenance.md` | Add two rows: runbook↔workflow lockstep; and `architectural-invariants.md`/risk-code-dir changes → mandatory risk-surface review + scheduled re-audit. | A |
| `docs/specs/README.md` | Spec-index — add the design doc + deferrals entries under "Implemented". | A |
| `scripts/risk-classification/classify.mjs` | Pure classification function: `(changedPaths, labels, grepHits) → { gated, surfaces, reasons }`. No I/O. | B |
| `scripts/risk-classification/classify.test.mjs` | `node:test` unit tests over sample inputs. | B |
| `scripts/risk-classification/run.mjs` | Thin runner: gathers changed paths + labels + runs content-greps, calls `classify`, emits label set + summary. | B |
| `.github/workflows/risk-classification.yml` | Advisory CI check (`pull_request`): runs the runner, applies/`removes` the gated label, posts a **non-blocking** check summary. | B |

---

## PART A — Runbook + doc wiring

### Task A1: Create the runbook `.ai/docs/issue-resolution-workflow.md`

**Files:**
- Create: `.ai/docs/issue-resolution-workflow.md`

The runbook is the agent-facing operational version of the spec. Pull all rationale/prose faithfully from the spec; the runbook's job is to be *imperative and checklist-shaped*. It MUST contain exactly these sections, in order, with the content described:

1. **Title + one-line purpose**, then a one-line pointer: "Rationale and rejected alternatives: see `docs/specs/2026-06-03-issue-resolution-workflow-design.md`."
2. **When this applies** — "You have been assigned a GitHub issue in this repo." Names the reference executor (Claude Code / CLI agent with write access) and states `@claude` mentions are advisory-only (no write scope).
3. **The decision tree** (the spine), as an explicit ordered procedure:
   ```
   1. Reproduce / restate. Establish acceptance criteria. (Hard-stop if not reproducible or criteria not inferable.)
   2. Classify TIER: T1 / T2 / T3. (When borderline, escalate up a tier.)
   3. Classify RISK: gated (UI-visual B1 OR risk-surface B2) vs hands-off. (When in doubt, gate.)
   4. Post the triage comment (template §6).
   5. Create worktree + branch.
   6. Run the tier pipeline (§5), pausing at the risk gate iff gated.
   7. Assemble the ## Proof section (template §7).
   8. pr-autopilot → green-and-ready.
   9. Notify (template §8). Human merges. (UI: pause for visual assert. Risk-surface: paused earlier, at spec/plan/pre-PR.)
   ```
4. **Tier table** — copy the T1/T2/T3 table from the spec verbatim, plus the escalate-up tie-break sentence.
5. **Per-tier pipelines** — copy the three pipeline code-blocks from the spec verbatim (T1, T2, T3), including the `[risk gate]` legend and the pre-PR-open re-check paragraph.
6. **Risk classification** — copy the spec's Axis-B section: the "when in doubt, gate" rule, the B1 definition, the B2 risk-surface table (all 8 rows incl. CI-gate-integrity, with detection-class column), and the **Enforcement = advisory + human-merge** scoping paragraph. State plainly: the agent self-classifies, posts it in the triage comment, and the human merge is the boundary.
7. **Triage-comment template** (NEW — not in spec; author it here):
   ```markdown
   ## Triage
   - **Tier:** T<n> — <one-line why>
   - **Risk:** <hands-off | gated: B1 UI | gated: B2 [surface]> — <one-line why>
   - **Acceptance criteria:** <restated, checkable>
   - **Approach:** <2–4 sentences>
   ```
8. **`## Proof` PR-body template** (NEW — author here), matching the spec's proof contract:
   ```markdown
   ## Proof
   ### Red-on-main (bug fixes)
   <commit-pinned failing output of the regression test against origin/main, then green on head>
   ### Acceptance criteria
   - [x] <criterion> — <test/commit/screenshot ref>
   ### Secrets scan
   <result of the §6 secrets scan over the diff>
   ### Visual (UI issues only)
   <before/after screenshots or recording>
   ### Doc-review dispositions (hands-off T2/T3)
   <each ce-doc-review finding: Applied | Deferred | Skipped + one-line reason>
   ```
9. **Gate substitution** — copy the spec's gate-substitution section (hands-off proceeds past human spec/plan gates; `ce-doc-review` substitutes; record dispositions; `ce-doc-review`-unavailable ⇒ treat stage as gated). State hands-off T3 is in scope (resolved).
10. **Notification template** (NEW — author here):
    ```markdown
    @<assignee> — <PR #> is <green-and-ready | awaiting your gate (B<n>)>.
    Tier T<n>, <risk>. Proof: <link to ## Proof>. Action needed: <merge | review approach | visual assert>.
    ```
    Plus the staleness rule: re-ping after N days; maintain a tracking list of PRs awaiting human action.
11. **Abort / escalation conditions** — copy the spec's list verbatim.
12. **Quiescence / bounded-loop definition** — copy the spec's Terms entries for green-and-ready and quiescent (3-cycle bound).

- [ ] **Step 1: Write the runbook file** with all 12 sections above, deriving prose from the named spec sections and authoring the three NEW templates (§7, §8, §10) exactly as shown.

- [ ] **Step 2: Verify structure and completeness**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -nE '^#|^##' .ai/docs/issue-resolution-workflow.md
```
Expected: headings for all 12 sections present, in order.

Run (must all return a match — no missing pieces):
```bash
grep -c 'When in doubt, gate' .ai/docs/issue-resolution-workflow.md   # >=1
grep -c 'CI-gate integrity'   .ai/docs/issue-resolution-workflow.md   # >=1 (self-coverage row)
grep -c '## Proof'            .ai/docs/issue-resolution-workflow.md   # >=1 (template)
grep -c 'advisory'            .ai/docs/issue-resolution-workflow.md   # >=1 (enforcement model)
grep -c 'human merge'         .ai/docs/issue-resolution-workflow.md   # >=1 (boundary)
```

- [ ] **Step 3: Verify no rationale drift from spec**

Read the runbook against the spec's Tier table, B2 risk-surface table (8 rows), and the three pipeline blocks. Confirm verbatim copies match (counts, surface names, detection classes). Fix any drift inline.

- [ ] **Step 4: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .ai/docs/issue-resolution-workflow.md
git commit -m "docs(workflow): add issue-resolution runbook to .ai/docs"
```

---

### Task A2: Wire the runbook into `.ai/README.md` and `CLAUDE.md`

**Files:**
- Modify: `.ai/README.md` (Doc index table)
- Modify: `CLAUDE.md` (shared-rules link table + Claude-only authorization note)

- [ ] **Step 1: Add the runbook row to `.ai/README.md`**

In the Doc index table (the `| File | Purpose |` table near the end), add after the `operating-context.md` row:
```markdown
| `issue-resolution-workflow.md` | Agent workflow for assigned issues — tiered, risk-gated, proof-carrying |
```
Also add `issue-resolution-workflow.md` to the `docs/` tree diagram in the Layout section.

- [ ] **Step 2: Add the runbook row to `CLAUDE.md` shared-rules table**

In the `## Shared rules (.ai/docs/)` table, add a row:
```markdown
| [`issue-resolution-workflow.md`](.ai/docs/issue-resolution-workflow.md) | Workflow any agent follows for an assigned GitHub issue |
```

- [ ] **Step 3: Record the gate-substitution authorization in `CLAUDE.md`**

Add a new subsection after the auto-review section:
```markdown
## Claude-only: hands-off issue work authorizes skipping the human spec/plan gate

For issues classified **hands-off** (non-gated) by `.ai/docs/issue-resolution-workflow.md`, an agent MAY proceed past the human spec/plan review gates that `superpowers:brainstorming` and `superpowers:writing-plans` bake in, using the machine `ce-doc-review` pass (2× for T3, 1× for T2) as the substitute sign-off and recording every finding's disposition in the PR's `## Proof` section. This authorization applies ONLY to hands-off issues; gated (UI-visual or risk-surface) issues retain the human gates. If `ce-doc-review` is unavailable, treat the stage as gated.
```

- [ ] **Step 4: Verify links resolve**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -c 'issue-resolution-workflow' .ai/README.md CLAUDE.md
test -f .ai/docs/issue-resolution-workflow.md && echo "target exists"
```
Expected: `.ai/README.md` ≥1, `CLAUDE.md` ≥2 (link table + authorization subsection), target exists.

- [ ] **Step 5: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .ai/README.md CLAUDE.md
git commit -m "docs(workflow): index runbook + authorize hands-off gate substitution"
```

---

### Task A3: Wire the runbook into Cursor rules

**Files:**
- Create: `.cursor/rules/issue-resolution.mdc`
- Modify: `.cursor/rules/README.md` (rule table)

- [ ] **Step 1: Create the Cursor rule**

Create `.cursor/rules/issue-resolution.mdc` (mirrors `base-rules.mdc` style — `mdc:` include, no copied body):
```markdown
---
description: Workflow for working an assigned GitHub issue — tiered, risk-gated, proof-carrying
alwaysApply: true
---

See [issue-resolution-workflow.md](mdc:../../.ai/docs/issue-resolution-workflow.md)
```

- [ ] **Step 2: Add the rule row to `.cursor/rules/README.md`**

In the rule table, add:
```markdown
| [`issue-resolution.mdc`](./issue-resolution.mdc) | **All files** | [`issue-resolution-workflow.md`](../../.ai/docs/issue-resolution-workflow.md) |
```

- [ ] **Step 3: Verify**

Run:
```bash
cd /c/src/PRism-issue-workflow
cat .cursor/rules/issue-resolution.mdc
grep -c 'issue-resolution' .cursor/rules/README.md   # >=1
```
Expected: frontmatter + single `mdc:` include line; README match ≥1.

- [ ] **Step 4: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .cursor/rules/issue-resolution.mdc .cursor/rules/README.md
git commit -m "docs(workflow): wire issue-resolution runbook into Cursor rules"
```

---

### Task A4: Add doc-maintenance rows

**Files:**
- Modify: `.ai/docs/documentation-maintenance.md` (the change-type table)

- [ ] **Step 1: Add two rows to the change-type table**

Add these rows to the `| Change type | Doc(s) to update |` table:
```markdown
| Change to the issue-resolution workflow (tiers, gates, proof contract, pipelines) | `.ai/docs/issue-resolution-workflow.md` kept in lockstep + `docs/specs/2026-06-03-issue-resolution-workflow-design.md` if rationale changes |
| New/changed architectural invariant, OR a change moving risk-surface code into a new directory | Mandatory review of the risk-surface table in `issue-resolution-workflow.md` + the `risk-classification.yml` globs/greps. Plus a scheduled (monthly) re-audit — code can drift a surface into a new path without touching `architectural-invariants.md`. |
```

- [ ] **Step 2: Verify**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -c 'issue-resolution-workflow' .ai/docs/documentation-maintenance.md   # >=1
grep -c 'risk-surface table' .ai/docs/documentation-maintenance.md          # >=1
```
Expected: both ≥1.

- [ ] **Step 3: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .ai/docs/documentation-maintenance.md
git commit -m "docs(workflow): add doc-maintenance rows for runbook + risk-surface drift"
```

---

### Task A5: Index the spec + deferrals in `docs/specs/README.md`

**Files:**
- Modify: `docs/specs/README.md` (Implemented group)

- [ ] **Step 1: Add the spec entry**

Under the `## Implemented` group, add (matching the existing entry format — design link, plan link, deferrals link):
```markdown
- [`2026-06-03-issue-resolution-workflow-design.md`](2026-06-03-issue-resolution-workflow-design.md) — agent-driven, proof-carrying, risk-gated issue workflow; plan: [`../plans/2026-06-03-issue-resolution-workflow.md`](../plans/2026-06-03-issue-resolution-workflow.md); deferrals: [`2026-06-03-issue-resolution-workflow-design-deferrals.md`](2026-06-03-issue-resolution-workflow-design-deferrals.md).
```
(If it lands before merge, this group is "Implemented"; if you prefer, place under an "In progress" group until the PR merges, then promote — per the spec-index convention.)

- [ ] **Step 2: Verify**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -c '2026-06-03-issue-resolution-workflow' docs/specs/README.md   # >=1
```
Expected: ≥1.

- [ ] **Step 3: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add docs/specs/README.md
git commit -m "docs(workflow): index issue-resolution spec + deferrals"
```

**Part A is independently shippable here.** Run the pre-push checklist (docs-only change touches no build, but confirm), open the PR via `pr-autopilot`, and merge. Part B may follow later or never.

---

## PART B — Advisory risk-classification CI check (optional / fast-follow)

> Do not start until Part A is merged. This adds a *second* automated surfacing layer; the agent's triage comment + label + the human merge already surface risk. Ship only if you want CI to independently re-assert the classification.

### Task B1: Pure classification module (TDD)

**Files:**
- Create: `scripts/risk-classification/classify.test.mjs`
- Create: `scripts/risk-classification/classify.mjs`

The function signature:
```js
// classify(input) -> { gated: boolean, surfaces: string[], reasons: string[] }
// input = { changedPaths: string[], labels: string[], grepHits: string[] }
//   grepHits: names of risk surfaces whose content-grep matched (computed by the runner, passed in)
```
Rules (from the spec's B2 table):
- A path under a path-localizable surface glob ⇒ that surface is gated.
- A `grepHits` entry ⇒ that surface is gated.
- A B1/B2 label already present (`area:auth`, `area:desktop`, `design`, `needs-design`) ⇒ corresponding surface/UI gated.
- Output is the union; `gated` is true iff `surfaces` is non-empty or a UI label is present.

- [ ] **Step 1: Write the failing tests**

```js
// scripts/risk-classification/classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './classify.mjs';

test('clean change is hands-off', () => {
  const r = classify({ changedPaths: ['frontend/src/util/format.ts'], labels: [], grepHits: [] });
  assert.equal(r.gated, false);
  assert.deepEqual(r.surfaces, []);
});

test('sidecar path is gated (path-localizable)', () => {
  const r = classify({ changedPaths: ['desktop/src/SidecarMode.ts'], labels: [], grepHits: [] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('desktop-sidecar'));
});

test('grep hit on submit-pipeline symbol is gated', () => {
  const r = classify({ changedPaths: ['PRism.Core/Submit/SubmitPipeline.cs'], labels: [], grepHits: ['reviewer-atomic-submit'] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('reviewer-atomic-submit'));
});

test('area:auth label alone gates', () => {
  const r = classify({ changedPaths: ['PRism.Core/Foo.cs'], labels: ['area:auth'], grepHits: [] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('auth'));
});

test('design label gates as UI', () => {
  const r = classify({ changedPaths: ['frontend/src/App.tsx'], labels: ['design'], grepHits: [] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('ui-visual'));
});

test('change to the risk workflow itself gates (CI-gate integrity)', () => {
  const r = classify({ changedPaths: ['.github/workflows/risk-classification.yml'], labels: [], grepHits: [] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('ci-gate-integrity'));
});

test('data-migration grep hit gates', () => {
  const r = classify({ changedPaths: ['PRism.Core/Inbox/InboxRefreshOrchestrator.cs'], labels: [], grepHits: ['data-migration'] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('data-migration'));
});

test('cross-tab-stamp grep hit gates', () => {
  const r = classify({ changedPaths: ['PRism.Core/CrossTab/StampGuard.cs'], labels: [], grepHits: ['cross-tab-stamp'] });
  assert.equal(r.gated, true);
  assert.ok(r.surfaces.includes('cross-tab-stamp'));
});
```

This covers every surface emitted by `classify` and every key in `run.mjs`'s `GREP_MAP` (the runner-side regex breadth is regression-locked separately in Task B2 Step 2a).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /c/src/PRism-issue-workflow/scripts/risk-classification && node --test`
Expected: FAIL — `Cannot find module './classify.mjs'`.

- [ ] **Step 3: Implement `classify.mjs`**

```js
// scripts/risk-classification/classify.mjs
// Path-localizable surfaces: glob-ish prefix/substring → surface id.
const PATH_RULES = [
  { surface: 'desktop-sidecar', test: p => /(^|\/)desktop\//.test(p) && /Sidecar|ParentLiveness|HostHeaderCheck/i.test(p) },
  { surface: 'ci-gate-integrity', test: p => p === '.github/workflows/risk-classification.yml' },
  // Note: auth/state/submit/cross-tab are mixed — they rely primarily on grepHits + labels
  // because their logic lives in generically-named files. Keep path rules conservative
  // to avoid false positives; the runner's content-grep is the primary signal for those.
];
const LABEL_RULES = [
  { surface: 'auth', label: 'area:auth' },
  { surface: 'desktop-sidecar', label: 'area:desktop' },
  { surface: 'ui-visual', label: 'design' },
  { surface: 'ui-visual', label: 'needs-design' },
];

export function classify({ changedPaths = [], labels = [], grepHits = [] }) {
  const surfaces = new Set();
  for (const p of changedPaths) for (const rule of PATH_RULES) if (rule.test(p)) surfaces.add(rule.surface);
  for (const l of labels) for (const rule of LABEL_RULES) if (rule.label === l) surfaces.add(rule.surface);
  for (const h of grepHits) surfaces.add(h);
  const list = [...surfaces];
  const reasons = list.map(s => `risk surface: ${s}`);
  return { gated: list.length > 0, surfaces: list, reasons };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/src/PRism-issue-workflow/scripts/risk-classification && node --test`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add scripts/risk-classification/classify.mjs scripts/risk-classification/classify.test.mjs
git commit -m "feat(ci): pure risk-classification module with node:test coverage"
```

---

### Task B2: Content-grep + changed-files runner

**Files:**
- Create: `scripts/risk-classification/run.mjs`

The runner gathers inputs and prints a result JSON. It receives the changed-paths list and labels via argv/env (the workflow supplies them from the PR context), runs content-greps over the changed files for the mixed/behavioral surfaces, then calls `classify`.

Grep map (surface id → regex over changed file contents), from the spec B2 table:
```js
// Regexes are anchored to specific symbols, NOT bare English words, to avoid
// false positives on incidental substrings (e.g. "timestamp" must NOT match
// cross-tab-stamp; a comment containing "migration" must NOT match data-migration).
const GREP_MAP = {
  'reviewer-atomic-submit': /pendingReviewId|threadId|replyCommentId|prism:client-id|submitPullRequestReview/,
  'auth': /RequiredScope|PatScope|TokenStore|MsalCacheHelper|keychain|DPAPI|libsecret/i,
  'data-migration': /state\.json|StateSchema|StateMigrat(e|ion)|MigrateState/,
  'cross-tab-stamp': /crossTabStamp|tabStamp|StampGuard|poisonGuard|stampPoison/,
};
```

- [ ] **Step 1: Write the runner**

```js
// scripts/risk-classification/run.mjs
import { readFileSync, existsSync } from 'node:fs';
import { classify } from './classify.mjs';

// Regexes are anchored to specific symbols, NOT bare English words, to avoid
// false positives on incidental substrings (e.g. "timestamp" must NOT match
// cross-tab-stamp; a comment containing "migration" must NOT match data-migration).
const GREP_MAP = {
  'reviewer-atomic-submit': /pendingReviewId|threadId|replyCommentId|prism:client-id|submitPullRequestReview/,
  'auth': /RequiredScope|PatScope|TokenStore|MsalCacheHelper|keychain|DPAPI|libsecret/i,
  'data-migration': /state\.json|StateSchema|StateMigrat(e|ion)|MigrateState/,
  'cross-tab-stamp': /crossTabStamp|tabStamp|StampGuard|poisonGuard|stampPoison/,
};

// changedPaths: newline list on argv[2] (a file) or PR_CHANGED_FILES env; labels: PR_LABELS env (comma list)
function readChangedPaths() {
  const file = process.argv[2];
  if (file && existsSync(file)) return readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  return (process.env.PR_CHANGED_FILES || '').split('\n').map(s => s.trim()).filter(Boolean);
}
const changedPaths = readChangedPaths();
const labels = (process.env.PR_LABELS || '').split(',').map(s => s.trim()).filter(Boolean);

const grepHits = new Set();
for (const p of changedPaths) {
  if (!existsSync(p)) continue;            // deleted/renamed files: skip content grep
  let body = '';
  try { body = readFileSync(p, 'utf8'); } catch { continue; }
  for (const [surface, re] of Object.entries(GREP_MAP)) if (re.test(body)) grepHits.add(surface);
}

const result = classify({ changedPaths, labels, grepHits: [...grepHits] });
process.stdout.write(JSON.stringify(result));
```

- [ ] **Step 2: Smoke-test the runner against the repo**

Use a repo-relative temp file (works under git-bash on the Windows worktree and on CI; clean it up after):
```bash
cd /c/src/PRism-issue-workflow
printf '.github/workflows/risk-classification.yml\n' > scripts/risk-classification/_smoke.txt
node scripts/risk-classification/run.mjs scripts/risk-classification/_smoke.txt
```
Expected: JSON containing `"gated":true` and `"ci-gate-integrity"` in surfaces.

```bash
cd /c/src/PRism-issue-workflow
printf 'README.md\n' > scripts/risk-classification/_smoke.txt
node scripts/risk-classification/run.mjs scripts/risk-classification/_smoke.txt
rm scripts/risk-classification/_smoke.txt
```
Expected: JSON `"gated":false`.

- [ ] **Step 2a: Regression-lock the regex breadth (false-positive guard)**

Create a fixture containing only the word `timestamp` and confirm it does NOT trip `cross-tab-stamp`:
```bash
cd /c/src/PRism-issue-workflow
mkdir -p scripts/risk-classification/_fix && printf 'const timestamp = Date.now(); // migration notes\n' > scripts/risk-classification/_fix/sample.ts
printf 'scripts/risk-classification/_fix/sample.ts\n' > scripts/risk-classification/_smoke.txt
node scripts/risk-classification/run.mjs scripts/risk-classification/_smoke.txt
rm -r scripts/risk-classification/_fix scripts/risk-classification/_smoke.txt
```
Expected: JSON `"gated":false` — `timestamp` must not match `cross-tab-stamp`, and `migration` (lowercase, no `State`/`Migrate` symbol) must not match `data-migration`. If either fires, the regex is still too broad — tighten it.

- [ ] **Step 3: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add scripts/risk-classification/run.mjs
git commit -m "feat(ci): risk-classification runner with content-grep over changed files"
```

---

### Task B3: Advisory CI workflow `risk-classification.yml`

**Files:**
- Create: `.github/workflows/risk-classification.yml`

Advisory contract: the workflow gathers the PR's changed files + labels, runs the runner, applies or removes the `gated` label, and posts a **non-blocking** summary comment. It does NOT set a required check and does NOT force draft (per the spec's enforcement model). Note: this workflow is itself in the `ci-gate-integrity` risk surface, so changes to it should be gated.

- [ ] **Step 1: Write the workflow**

```yaml
name: Risk classification (advisory)

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write   # to apply/remove the advisory label + comment

jobs:
  classify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Collect changed files
        run: |
          git diff --name-only origin/${{ github.base_ref }}...HEAD > changed.txt
          cat changed.txt

      - name: Ensure the advisory `gated` label exists
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh label create gated --color E11D48 --description "Advisory: touches a risk surface; needs human review before merge" --force

      - name: Classify
        id: classify
        env:
          PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}
        run: |
          RESULT=$(node scripts/risk-classification/run.mjs changed.txt)
          echo "result=$RESULT" >> "$GITHUB_OUTPUT"
          echo "$RESULT"

      - name: Apply advisory label + summary (non-blocking)
        uses: actions/github-script@v7
        env:
          CLASSIFY_RESULT: ${{ steps.classify.outputs.result }}
        with:
          script: |
            // Read via env, never interpolate a step output into the script body
            // (avoids the github-script template-literal injection anti-pattern and
            // degrades gracefully if the prior step emitted nothing).
            let result;
            try { result = JSON.parse(process.env.CLASSIFY_RESULT || '{}'); }
            catch { result = { gated: false, surfaces: [], reasons: ['classify output unparseable'] }; }
            const pr = context.issue.number;
            const body = result.gated
              ? `⚠️ **Risk classification: GATED** — surfaces: ${result.surfaces.join(', ')}.\nThis PR touches a risk surface. Per the issue-resolution workflow it needs a human approach/visual review before merge. (Advisory — does not block.)`
              : `✅ **Risk classification: hands-off** — no risk surface detected. (Advisory.)`;
            await github.rest.issues.createComment({ ...context.repo, issue_number: pr, body });
            // Advisory `gated` label, kept in sync both ways so a PR that drops back
            // to hands-off on a later push has the label removed.
            const has = (await github.rest.issues.listLabelsOnIssue({ ...context.repo, issue_number: pr }))
              .data.some(l => l.name === 'gated');
            if (result.gated && !has) {
              await github.rest.issues.addLabels({ ...context.repo, issue_number: pr, labels: ['gated'] });
            } else if (!result.gated && has) {
              try { await github.rest.issues.removeLabel({ ...context.repo, issue_number: pr, name: 'gated' }); } catch (e) {}
            }
```

Label choice (resolved): use a **dedicated `gated` label**, not `needs-design`. Reusing `needs-design` would collide with the B1 UI-visual trigger in `classify.mjs` (`LABEL_RULES` maps `needs-design → ui-visual`), causing a non-UI B2 PR to re-classify as UI on the next run — a false-positive feedback loop. The dedicated label is created idempotently by the step above (`--force`) so the workflow is self-contained.

- [ ] **Step 2: Verify the workflow is valid YAML and references real paths**

Run:
```bash
cd /c/src/PRism-issue-workflow
node -e "const y=require('fs').readFileSync('.github/workflows/risk-classification.yml','utf8'); if(!y.includes('run.mjs')) throw new Error('runner not referenced'); console.log('ok')"
test -f scripts/risk-classification/run.mjs && echo "runner exists"
```
Expected: `ok` and `runner exists`. (If a YAML linter is available, run it; otherwise the above guards the critical references.)

- [ ] **Step 3: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .github/workflows/risk-classification.yml
git commit -m "feat(ci): advisory risk-classification workflow (non-blocking)"
```

- [ ] **Step 4: Verify advisory behavior on the PR itself**

After pushing and opening the PR, confirm the new workflow ran, posted its summary comment, and that the PR remains mergeable (the check is NOT in `main`'s required checks — confirm `gh pr checks` shows it as non-required / the merge button is not blocked by it). Capture this confirmation in the PR's `## Proof` section.

---

## Self-Review (completed by plan author)

**Spec coverage:** Every spec section maps to a task — runbook (A1) covers Purpose/Terms/axes/pipelines/proof/gates/abort; doc-wiring (A2–A5) covers the Deliverables "Core" table; `risk-classification.yml` (B1–B3) covers the advisory check incl. the CI-gate-integrity self-coverage row. Enforcement-hardening items are intentionally absent (deferred per OPEN DECISION 2). The "minimum agent capability" open item is prose for the runbook (A1 §2) not a separate task.

**Placeholder scan:** Doc tasks specify exact section lists + author the three new templates in full; code tasks contain complete, runnable code and real test bodies. The label choice is now resolved in-plan (dedicated `gated` label), not left as a TODO.

**Type consistency:** `classify({ changedPaths, labels, grepHits }) → { gated, surfaces, reasons }` is used identically in B1 (tests + impl) and B2 (runner). Surface ids (`desktop-sidecar`, `reviewer-atomic-submit`, `auth`, `data-migration`, `cross-tab-stamp`, `ci-gate-integrity`, `ui-visual`) are consistent between `classify.mjs`, the tests, and `run.mjs`'s `GREP_MAP` — and after the round-1 fix, B1 has a test for **every** surface emitted by `classify` (8 tests), including `data-migration` and `cross-tab-stamp` (previously defined in `GREP_MAP` but untested). The runner-side regex breadth is regression-locked by Task B2 Step 2a.

**Security note:** The advisory workflow reads the classifier output via an `env:` var (`CLASSIFY_RESULT`), never interpolated into the `github-script` body, and guards `JSON.parse`. The `classify` output is a fixed controlled vocabulary (surface ids), so no attacker-controlled path/content text reaches the script context.
