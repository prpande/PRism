# Issue-Resolution Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent-driven, proof-carrying, risk-gated issue-resolution workflow as a **single guidance runbook** plus its doc-index wiring.

**Architecture:** The deliverable is documentation only — no code, no `.yml`, no CI checks. `.ai/docs/issue-resolution-workflow.md` is the agent-facing runbook; the rest of the tasks wire it into the indexes the repo's doc-maintenance contract requires (`.ai/README.md`, `.cursor/rules/`, `CLAUDE.md`, `docs/specs/README.md`, `documentation-maintenance.md`). The agent self-classifies each issue against the runbook's guidance, records the classification in a triage comment, and the human merge is the safety boundary.

**Tech Stack:** Markdown only. `.cursor/rules` uses `mdc:` includes (no copied bodies). Verification steps run under git-bash on the Windows worktree.

**Source spec:** [`docs/specs/2026-06-03-issue-resolution-workflow-design.md`](../specs/2026-06-03-issue-resolution-workflow-design.md) — authoritative for all rationale/prose. **Deferrals:** [`docs/specs/2026-06-03-issue-resolution-workflow-design-deferrals.md`](../specs/2026-06-03-issue-resolution-workflow-design-deferrals.md).

**Note:** Mechanical enforcement (a CI risk-classification check, secrets-scan workflow, branch protection) was explicitly **rejected** — see the spec's "Deferred / rejected" section. This plan ships guidance only.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `.ai/docs/issue-resolution-workflow.md` | **The runbook.** Agent-facing, imperative rendering of the spec: the two-axis decision tree, the risk-surface table, the triage-comment / `## Proof` / notification templates, the per-tier pipelines, the abort/escalation list, and the quiescence/iteration definitions. |
| `.ai/README.md` | Doc-index table + layout tree — add the runbook. |
| `.cursor/rules/issue-resolution.mdc` | New Cursor rule including the runbook via `mdc:` link, scoped to all files. |
| `.cursor/rules/README.md` | Cursor rule-table — add the new rule row. |
| `CLAUDE.md` | Add the runbook to the shared-rules link table **and** record the gate-substitution authorization. |
| `.ai/docs/documentation-maintenance.md` | Add two rows: runbook↔workflow lockstep; and `architectural-invariants.md`/risk-code-dir changes → mandatory risk-surface-table review + scheduled re-audit. |
| `docs/specs/README.md` | Spec-index — add the design doc + deferrals entries. |

---

### Task 1: Create the runbook `.ai/docs/issue-resolution-workflow.md`

**Files:**
- Create: `.ai/docs/issue-resolution-workflow.md`

The runbook is the agent-facing operational version of the spec. Pull all rationale/prose faithfully from the spec; the runbook's job is to be *imperative and checklist-shaped*. It MUST contain exactly these sections, in order:

1. **Title + one-line purpose**, then: "Rationale and rejected alternatives: see `docs/specs/2026-06-03-issue-resolution-workflow-design.md`." State plainly: **this is guidance, not enforcement — there is no CI check; the human merge is the boundary.**
2. **When this applies** — "You have been assigned a GitHub issue in this repo." Names the reference executor (Claude Code / CLI agent with write access); states `@claude` mentions are advisory-only (no write scope); states a minimum-capability expectation (the agent must be able to read the codebase, run the test suite, and reason about the risk-surface table).
3. **The decision tree** (the spine), as an explicit ordered procedure:
   ```
   1. Reproduce / restate. Establish acceptance criteria. (Hard-stop if not reproducible — even statistically — or criteria not inferable.)
   2. Classify TIER: T1 / T2 / T3. (When borderline, escalate up a tier.)
   3. Classify RISK: gated (UI-visual B1 OR risk-surface B2) vs hands-off. (When in doubt, gate.)
   4. Post the triage comment (template §6).
   5. Create worktree + branch.
   6. Run the tier pipeline (§5), pausing at the risk gate iff gated.
   7. Pre-PR re-check: re-read the diff against the risk table; if a surface was missed, re-classify to gated.
   8. Assemble the ## Proof section (template §7).
   9. pr-autopilot → green-and-ready.
   10. Notify (template §8). Human merges. (UI: pause for visual assert. Risk-surface: paused earlier, at spec/plan/pre-PR.)
   ```
4. **Tier table** — copy the T1/T2/T3 table from the spec verbatim, plus the escalate-up tie-break sentence.
5. **Per-tier pipelines** — copy the three pipeline code-blocks from the spec verbatim (T1, T2, T3), including the `[risk gate]` legend and the pre-PR-open re-check paragraph.
6. **Risk classification** — copy the spec's Axis-B section: the "when in doubt, gate" rule, the B1 definition, the B2 risk-surface table (7 rows, "Signals the agent looks for" column), and the **"How the agent applies this (no tooling)"** paragraph. State plainly: the agent self-classifies, records it in the triage comment, and the human merge is the boundary — there is no CI check.
7. **Triage-comment template** (NEW — author here):
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
    Plus the staleness rule: re-ping after N days; keep a tracking list of PRs awaiting human action.
11. **Abort / escalation conditions** — copy the spec's list verbatim.
12. **Quiescence / bounded-loop definition** — copy the spec's Terms entries for green-and-ready and quiescent (3-cycle bound).

- [ ] **Step 1: Write the runbook file** with all 12 sections above, deriving prose from the named spec sections and authoring the three NEW templates (§7, §8, §10) exactly as shown.

- [ ] **Step 2: Verify structure and completeness**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -nE '^#|^##' .ai/docs/issue-resolution-workflow.md
```
Expected: headings for all 12 sections, in order.

Run (each must return ≥1):
```bash
cd /c/src/PRism-issue-workflow
for s in 'When in doubt, gate' 'no CI check' '## Proof' 'human merge' 'Triage' 'pr-autopilot'; do printf '%s => ' "$s"; grep -c "$s" .ai/docs/issue-resolution-workflow.md; done
```
Expected: every count ≥1. Confirm the runbook does NOT reference a `risk-classification.yml`, a CI gate, or any enforcement check (this is guidance-only):
```bash
cd /c/src/PRism-issue-workflow
grep -in 'risk-classification.yml\|required status check\|forces draft' .ai/docs/issue-resolution-workflow.md || echo "OK: no enforcement-tooling references"
```
Expected: `OK: no enforcement-tooling references`.

- [ ] **Step 3: Verify no rationale drift from spec**

Read the runbook against the spec's Tier table, B2 risk-surface table (7 rows), and the three pipeline blocks. Confirm the copies match (row counts, surface names). Fix any drift inline.

- [ ] **Step 4: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .ai/docs/issue-resolution-workflow.md
git commit -m "docs(workflow): add issue-resolution runbook to .ai/docs"
```

---

### Task 2: Wire the runbook into `.ai/README.md` and `CLAUDE.md`

**Files:**
- Modify: `.ai/README.md` (Doc index table + Layout tree)
- Modify: `CLAUDE.md` (shared-rules link table + Claude-only authorization note)

- [ ] **Step 1: Add the runbook row to `.ai/README.md`**

In the Doc index table (the `| File | Purpose |` table), add after the `operating-context.md` row:
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

### Task 3: Wire the runbook into Cursor rules

**Files:**
- Create: `.cursor/rules/issue-resolution.mdc`
- Modify: `.cursor/rules/README.md` (rule table)

- [ ] **Step 1: Create the Cursor rule** (mirrors `base-rules.mdc` — `mdc:` include, no copied body):
```markdown
---
description: Workflow for working an assigned GitHub issue — tiered, risk-gated, proof-carrying
alwaysApply: true
---

See [issue-resolution-workflow.md](mdc:../../.ai/docs/issue-resolution-workflow.md)
```

- [ ] **Step 2: Add the rule row to `.cursor/rules/README.md`**:
```markdown
| [`issue-resolution.mdc`](./issue-resolution.mdc) | **All files** | [`issue-resolution-workflow.md`](../../.ai/docs/issue-resolution-workflow.md) |
```

- [ ] **Step 3: Verify**

Run:
```bash
cd /c/src/PRism-issue-workflow
cat .cursor/rules/issue-resolution.mdc
grep -c 'issue-resolution' .cursor/rules/README.md
```
Expected: frontmatter + single `mdc:` include line; README match ≥1.

- [ ] **Step 4: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .cursor/rules/issue-resolution.mdc .cursor/rules/README.md
git commit -m "docs(workflow): wire issue-resolution runbook into Cursor rules"
```

---

### Task 4: Add doc-maintenance rows

**Files:**
- Modify: `.ai/docs/documentation-maintenance.md` (the change-type table)

- [ ] **Step 1: Add two rows to the change-type table**:
```markdown
| Change to the issue-resolution workflow (tiers, gates, proof contract, pipelines) | `.ai/docs/issue-resolution-workflow.md` kept in lockstep + `docs/specs/2026-06-03-issue-resolution-workflow-design.md` if rationale changes |
| New/changed architectural invariant, OR a change moving risk-surface code into a new directory | Mandatory review of the risk-surface table in `issue-resolution-workflow.md`. Plus a scheduled (monthly) re-audit — code can drift a surface into a new path without touching `architectural-invariants.md`. |
```

- [ ] **Step 2: Verify**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -c 'issue-resolution-workflow' .ai/docs/documentation-maintenance.md
grep -c 'risk-surface table' .ai/docs/documentation-maintenance.md
```
Expected: both ≥1.

- [ ] **Step 3: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add .ai/docs/documentation-maintenance.md
git commit -m "docs(workflow): add doc-maintenance rows for runbook + risk-surface drift"
```

---

### Task 5: Index the spec + deferrals in `docs/specs/README.md`

**Files:**
- Modify: `docs/specs/README.md` (Implemented group)

- [ ] **Step 1: Add the spec entry** under `## Implemented` (matching the existing format):
```markdown
- [`2026-06-03-issue-resolution-workflow-design.md`](2026-06-03-issue-resolution-workflow-design.md) — agent-driven, proof-carrying, risk-gated issue workflow (guidance runbook); plan: [`../plans/2026-06-03-issue-resolution-workflow.md`](../plans/2026-06-03-issue-resolution-workflow.md); deferrals: [`2026-06-03-issue-resolution-workflow-design-deferrals.md`](2026-06-03-issue-resolution-workflow-design-deferrals.md).
```

- [ ] **Step 2: Verify**

Run:
```bash
cd /c/src/PRism-issue-workflow
grep -c '2026-06-03-issue-resolution-workflow' docs/specs/README.md
```
Expected: ≥1.

- [ ] **Step 3: Commit**

```bash
cd /c/src/PRism-issue-workflow
git add docs/specs/README.md
git commit -m "docs(workflow): index issue-resolution spec + deferrals"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** Every spec section maps to Task 1's runbook (Purpose/Terms/axes/pipelines/proof/gates/abort/quiescence); Tasks 2–5 cover the spec's Deliverables table (runbook, `CLAUDE.md`, `.ai/README.md`, `.cursor/rules/`, `documentation-maintenance.md`, `docs/specs/README.md`). The rejected items (CI check, secrets-scan workflow, branch protection) are intentionally absent.

**Placeholder scan:** Doc tasks specify exact section lists and author the three new templates (§7, §8, §10) in full. Verification steps are concrete `grep`/`test` commands with expected output. No TODOs.

**Consistency:** The runbook is the single source; every wiring task points at the same path `.ai/docs/issue-resolution-workflow.md`. Task 1 Step 2 explicitly asserts the runbook contains no enforcement-tooling references, matching the guidance-only spec.
