# Issue-resolution workflow (agent-driven, proof-carrying, risk-gated)

**Status:** Design · **Date:** 2026-06-03 · **Topic:** issue-resolution-workflow

## Purpose

Define a single, standard workflow that a coding agent follows when assigned a
GitHub issue in this repo. The workflow is **hands-off by default** — it runs
intake → fix → proof → green PR without human involvement — and **pauses for the
human only when the change needs human judgment**: a UI-visual change, or a
change that touches a defined high-risk surface.

The workflow exists to make two guarantees:

1. **Proof of fix.** Every PR carries machine-checkable evidence that it actually
   resolves the issue — not just that the build is green.
2. **Bounded autonomy.** The agent runs unsupervised exactly where unsupervised
   operation is safe, and stops for a human exactly where it is not.

This document is the design (spec). The implementation artifact is the runbook
`.ai/docs/issue-resolution-workflow.md` plus its wiring into the doc index. See
**Deliverables** below.

### What this actually changes (baseline delta)

The repo already runs a `/code-review` bot on every PR and already requires a
human to perform the merge. Both stay. **The only human step this workflow
removes for non-gated work is the spec/plan *review* gate** that `brainstorming`
and `writing-plans` bake in — the point where the agent would normally stop and
wait for the human to read the spec/plan before implementing. Everything else
(bot review, human merge) is unchanged. Naming this delta sets the bar: the
two-axis classification machinery below is justified only insofar as removing
that one gate — safely — is worth the maintenance it carries.

### This is guidance, and the enforcement boundary is the human merge (decided)

**This workflow is a guidance document, not enforcement tooling.** The deliverable
is a single markdown runbook the agent follows; there is no CI check, no `.yml`,
and no mechanical gate. The agent classifies its own change against the guidance
below, records the classification in its triage comment, and — for gated changes
— pauses and notifies the human. **The safety boundary is the human merge**, which
already exists (the human merges every PR). "Gated" therefore means **surfaced to
the human**, not mechanically blocked.

This is deliberate (OPEN DECISION 2, resolved). Building mechanical enforcement
(a required CI check, branch protection, a separate approver identity) was
considered and **rejected/deferred** (see the deferrals sidecar): for a
single-maintainer PoC where the human already reviews and merges every PR, the
guidance + the human merge is sufficient, and the design must not claim mechanical
agent-independence it does not have.

### Terms

- **Gated** — the agent **pauses and waits for human judgment** before
  proceeding past a defined gate.
- **Hands-off** — the agent **proceeds without pausing** for any gate; the PR
  reaches green-and-ready before the human is notified, and the human performs
  the merge. (A human may still comment on a hands-off PR; hands-off describes
  the *absence of a blocking gate*, not a prohibition on human involvement.)
- **Green-and-ready** — CI green (all required workflows pass) **and**
  `/code-review` bot **quiescent** **and** the `## Proof` section complete. The
  terminal state of every hands-off run.
- **Quiescent** — one full CI + `/code-review` cycle completes with **zero new
  actionable bot comments** after the latest push. Because the bot is a
  non-deterministic LLM review that re-runs on every `synchronize` event, the
  loop is bounded: after **3** consecutive address→push→re-review cycles that
  still surface new actionable comments, the agent escalates to the human rather
  than looping further. (`pr-autopilot` owns the loop; this is the terminal
  condition it drives toward.)

## Non-goals

- This is not a new plugin or skill. It reuses the skills the repo already
  relies on (`brainstorming`, `ce-doc-review`, `writing-plans`,
  `executing-plans`, `pr-autopilot`, `pr-followup`) and the existing CI /
  `claude-code-review` automation. It does not wrap them in new machinery.
- It does not change the TDD mandate, the architectural invariants, or the
  doc-maintenance rules. It composes on top of them.
- It does not introduce auto-merge. The agent stops at green-and-ready; the human
  performs the merge (see **Terminal action**) — that human merge is the
  enforcement boundary (above).

## Who executes this workflow

The executable workflow targets a **Claude Code session (or equivalent CLI
agent) running with repository write access** — the only agent class that can
create branches, push commits, apply labels, post comments, and open PRs while
invoking the skills the pipelines name. This is the **reference executor**.

Two boundary cases the design explicitly scopes out of "hands-off executor":

- **`@claude` mentions** run via `claude.yml` with `contents: read` /
  `pull-requests: read` / `issues: read` — **no write scope**. An `@claude` run
  therefore **cannot author the fix or the PR**; its role is **advisory only**
  (answering questions, suggesting approaches on an existing PR/issue). It is not
  a hands-off executor.
- **Other CLI agents (e.g. an assigned Copilot agent)** can only follow this
  workflow if they have write access *and* a way to reproduce each stage's
  intent. The runbook therefore states each pipeline stage as an **agent-neutral
  intent** ("drive the reviewer-bot loop to quiescence and assert CI green"),
  with the Claude skill named as the **reference implementation**. A non-Claude
  agent must reproduce the intent; it does not get the skill for free.

## The governing model: two independent axes

Every assigned issue is classified on **two axes** at intake. The axes are
orthogonal: one sets how much paperwork the change carries, the other sets
whether a human gate fires.

### Axis A — Tier (how much ceremony)

Tier scales with size, blast radius, and how much design judgment the change
demands. **It does not depend on risk** (that is Axis B).

| Tier | Trigger | Pipeline (summary) |
|------|---------|--------------------|
| **T1 — Direct** | Small, localized fix with a clear reproduction. Roughly one file of production change; no meaningful design choice. (e.g. a stale-lock bug, a flaky-test fix, an off-by-one.) | regression test (red on `main`) → fix → PR. No spec, no plan. |
| **T2 — Light** | Medium change touching ~2–4 files, or one real design choice, but still a single coherent unit of work. | (bug: red-on-main test first) → short spec (1× `ce-doc-review`) → TDD execute → PR. No separate plan. |
| **T3 — Full** | Slice-sized work, genuinely new behavior, or cross-cutting change. The repo's standard path. | `brainstorming` → spec → 2× `ce-doc-review` → `writing-plans` → plan → 2× `ce-doc-review` → `executing-plans` (TDD) → PR. |

**Tie-break rule: when a change sits on a T1/T2 or T2/T3 boundary, escalate up a
tier.** Misclassification must fail toward *more* rigor, never less. An agent is
never penalized for treating a borderline T1 as a T2.

### Axis B — Risk (whether a human gate fires)

A change is **gated** (it pauses for the human) if it meets *either* condition
below. Otherwise it is **hands-off**.

**Axis-B tie-break: when in doubt, gate.** Mirroring the tier rule, risk
misclassification must fail toward *more* supervision. Under-gating is the
catastrophic direction (an unsupervised change to a sensitive surface); a
false-positive gate costs only one human glance. If the agent is less than
confident a change is clear of every surface below, it gates.

**B1 — UI-visual.** The issue carries the `design` or `needs-design` label, OR
the change alters rendered output whose correctness a human must eyeball (layout,
spacing, color, typography, motion, copy, component composition). CI cannot
assert "looks right," so a human must.

**B2 — Risk-surface.** The change touches one of the following surfaces, each
anchored to `architectural-invariants.md`. The *signals* column gives the agent
concrete things to look for when self-classifying — changed paths, symbol names,
and labels. They are **heuristics for the agent's judgment**, not mechanical
rules; some surfaces (behavioral invariants) have no reliable path/symbol
footprint at all, so when in doubt the agent gates.

| Risk surface | Signals the agent looks for |
|--------------|------------------------------|
| Auth / PAT scopes / token storage | Token-storage paths; PAT-scope *validation logic* (lives in generically-named files, e.g. submit/reconciliation pipelines); symbols like `RequiredScope`/`PatScope`/`TokenStore`/MSAL cache; `area:auth` label. |
| Reviewer-atomic submit pipeline | The pending-review GraphQL pipeline (`addPullRequestReview` → thread/reply → `submitPullRequestReview`); `pendingReviewId`/`threadId`/`replyCommentId`/`prism:client-id`. |
| Data migrations / persisted schema | `state.json` read/write and migration logic (spread across multiple files); schema/migration symbols. |
| Cross-tab stamp / poisoning protocol | The `TabStamp` type and stamp/poisoning-guard logic. |
| Desktop sidecar seams | `SidecarMode`, `ParentLivenessProbe`/`Watchdog`, `HostHeaderCheckMiddleware`, the `127.0.0.1` bind; `area:desktop` label. |
| Architectural invariants | Any change touching a decision in `architectural-invariants.md`, including behavioral ones (`Banner, not mutation`; `Truthful by default`; Octokit source-hygiene; kebab-case enums; opaque Node IDs) that have no stable path footprint — when unsure, gate. |
| Security surface | Host-header check, bind address, secret/credential handling; `behavioral-guidelines.md` §6. |

**How the agent applies this (no tooling).** The agent reads the change against
the table, decides hands-off vs gated, and **records the decision and its reason
in the triage comment** (Stage 0). There is no CI check that re-computes or
enforces this — the classification is the agent's, surfaced for the human, and
the human merge is the boundary. The Axis-B "when in doubt, gate" rule is what
protects against the inevitable gaps in the agent's judgment (especially on
behavioral surfaces with no obvious signal); the human merge is the backstop.

If a change touches a risk surface **but the issue was not labeled** for it, the
agent applies the label and treats it as gated. **Re-classification is
mandatory mid-flight:** if an agent discovers partway through that its change has
grown into a risk surface, it stops, re-classifies as gated, updates its triage
comment, and routes to the human gate. The only backstop for a missed
re-classification is the human merge — there is no CI check behind it, which is
exactly why the "when in doubt, gate" rule and the human merge matter.

### How the axes compose

- **Tier sets the paperwork. Risk sets the human gate.** They are decided
  independently and both always apply.
- A **T3 large feature that does not touch the risk surface runs hands-off**
  (OPEN DECISION 1, resolved: hands-off T3 is in scope): the machine
  `ce-doc-review` passes substitute for the human spec/plan review gates that
  `brainstorming` and `writing-plans` bake in (see **Gate substitution** and its
  accepted residual risk).
- A **T1 one-liner that touches auth is gated**: tiny paperwork, but it pauses
  for the human because the *approach* needs judgment.

## Stage 0 — Intake & triage (all tiers, all risk levels)

1. **Pick up** the assigned issue; read it and the code it references.
2. **Reproduce** (bugs) or **restate the ask** (features). For a bug, establish a
   concrete, runnable reproduction now — it becomes the red-on-main test later.
3. **Classify** Tier (A) and Risk (B). Apply any missing labels (`priority:*`,
   `area:*`, `design`/`needs-design`).
4. **Post a triage comment** on the issue containing:
   - assigned **Tier** and **Risk** classification, each with a one-line *why*;
   - the **acceptance criteria** the agent will prove against (extracted from the
     issue, or proposed if the issue is thin — see hard-stop below);
   - the planned **approach** in 2–4 sentences.
5. **Create an isolated worktree + branch** (`git worktree add <path> -b
   <branch>`). The agent never works on an existing branch.

**Hard stop conditions at intake** (agent stops and asks the human):

- **A bug that cannot be reproduced** — even probabilistically. A bug is
  *reproducible* for this workflow if a regression test reliably reds-on-`main`
  either deterministically or under a bounded retry/stress harness (this repo has
  concurrency-class surfaces — cross-tab stamp, parent-liveness — whose tests are
  statistical, not single-run deterministic). A bug that cannot be made to red
  reliably has no provable fix; hands-off is impossible by definition.
- **Acceptance criteria ambiguous or absent and not confidently inferable.** If
  the agent proposes criteria but they are not concrete enough to be checked
  against a test/commit/screenshot, that is itself a hard stop — the proof
  contract has nothing to bind to.

## The three pipelines

All three converge on the same **proof contract**, the same **risk check**, and
the same `pr-autopilot` terminal stage. Tier changes only the upstream paperwork.
`[risk gate]` below means: **if the change is gated (B1/B2), pause for the human
at this point; if hands-off, proceed.**

### T1 — Direct fix

```
reproduce
→ write regression test; run it; confirm RED on main (capture failing output)
→ implement the minimal fix
→ test GREEN; full local pre-push checklist (.ai/docs/development-process.md)
→ [risk gate — gated: notify human BEFORE opening PR]
→ pr-autopilot
```

### T2 — Light

```
(bug work: reproduce → regression test RED on main first)
→ write a short spec → docs/specs/YYYY-MM-DD-<topic>-design.md
→ 1× ce-doc-review → apply surviving findings (receiving-code-review rigor)
→ [risk gate — gated: notify human on the SPEC/approach before TDD]
→ TDD execute (red → green per behavior)
→ local pre-push checklist
→ pr-autopilot
```

### T3 — Full (the repo's standard path)

```
brainstorming → spec (docs/specs/)
→ 2× ce-doc-review → apply surviving findings
→ [spec gate — GATED (B1/B2): human reviews spec | HANDS-OFF: proceed]
→ writing-plans → plan (docs/plans/)
→ 2× ce-doc-review → apply surviving findings
→ [plan gate — GATED (B1/B2): human reviews plan | HANDS-OFF: proceed]
→ executing-plans (TDD)
→ local pre-push checklist
→ pr-autopilot
```

**Pre-PR-open re-check (all tiers).** Immediately before opening the PR, the
agent re-reads the actual committed diff against the Axis-B table and compares it
to the intake classification. A discrepancy (a risk surface touched that was not
gated at intake) forces the issue to gated and routes to the human gate. UI (B1)
changes are re-checked here too. This is an agent self-check; the human merge is
the only backstop behind it.

## Gate substitution (the core hands-off mechanism)

`brainstorming` and `writing-plans` bake in human-review gates ("ask the user to
review the spec/plan before proceeding"). The repo's `CLAUDE.md` also requires a
human pass after `ce-doc-review`.

For **hands-off (non-gated)** issues, the agent **proceeds past those human gates
without pausing**, and the machine `ce-doc-review` pass (2× for T3, 1× for T2) is
the substitute sign-off. The agent records in the PR body that it did so, and
surfaces every `ce-doc-review` finding with its disposition (Applied / Deferred /
Skipped + one-line reason), exactly as the `CLAUDE.md` visible-rejection rule
requires.

This deviation from the skills' defaults **will be authorized by a `CLAUDE.md`
update (per Deliverables)** — it is not yet in force as of this spec. It applies
*only* to non-gated issues. For gated issues, the human gates fire as the skills
intend.

**Residual risk (stated, not resolved).** The human spec/plan gate and the
machine `ce-doc-review` pass catch *different* classes of problem.
`ce-doc-review` reviews the *document* for coherence, feasibility, scope, and
ambiguity — it is strong at "is this spec internally sound." The human gate
exists to catch what the author (here, the agent) got *wrong about what to build*
— wrong premise, wrong scope, building the wrong thing. Substituting the machine
pass for the human gate on **net-new T3 behavior** means no independent party
evaluates the *approach* before the PR is merge-ready. The accepted bound is that
the human still performs the merge, so the worst case is "a human merges a PR
whose approach they would have steered differently" → rework, not a silent
production change. **This residual is accepted** (OPEN DECISION 1, resolved):
hands-off T3 is in scope, bounded by the human merge.

**Fallback when `ce-doc-review` is unavailable.** If `ce-doc-review` cannot run
(not installed in the session), the substitute sign-off does not exist — the
agent **treats that stage as gated** and requests a human review, mirroring the
`CLAUDE.md` fallback rule. It does not proceed hands-off on an unsigned spec/plan.

## Proof-of-fix contract

Before a PR is **green-and-ready**, its body MUST contain a `## Proof` section
with the following, as applicable:

1. **Red-on-main evidence** *(bug fixes)* — the regression test's **failing**
   output captured against `main` *before* the fix, alongside the same test
   passing on the PR head. **Capture mechanic:** run the regression test against
   a clean checkout of `origin/main` on a CI-matching toolchain (this repo:
   `windows-latest`, .NET 10, Node 24) and paste **commit-pinned local output**
   in the `## Proof` section. (There is no dedicated red-baseline CI job — this is
   self-captured, consistent with the guidance-only model.) For
   statistical/concurrency bugs,
   red-on-main means the test reds reliably under the defined retry/stress
   budget, not on a single run. This is the anti-tautology guard: without
   verifiable red-on-main, the test does not prove the bug existed, and the fix
   is **not** done.
2. **Acceptance-criteria checklist** — the issue's acceptance criteria restated
   as `- [x]` items, each pointing at the test, commit, or screenshot that
   satisfies it.
3. **Secrets scan clean** — the agent scans the diff for hardcoded secrets per
   `behavioral-guidelines.md` §6 and records the result. Because gate substitution
   removes the human pass that would otherwise catch a leaked credential, this item
   is **required on every PR**. It is self-attested and human-merge-backed
   (guidance-only model — no CI secrets-scan).
4. **Visual proof** *(UI issues only)* — before/after screenshots or a short
   recording, attached for the human visual-assert gate.
5. **Green CI** — enforced as a **process invariant** by `pr-autopilot`'s
   terminal gate (CI workflows + `/code-review` bot quiescent, per **Terms**).
   Not pasted as a separate artifact.

**Non-bug work** (enhancements / tech-debt) where red-on-main does not apply: the
proof is the new tests authored test-first (red → green *within* the PR's
history) plus the acceptance checklist. The TDD mandate already requires these;
the proof contract only requires surfacing them.

## Gates & terminal action

### Hands-off (non-gated) issues

Intake → pipeline → `pr-autopilot` drives to **green-and-ready** (per **Terms**).
The agent then **stops and notifies the human** (see Notification below) with the
PR link and a proof summary. The human performs the one-click merge — the
enforcement boundary. No pause anywhere between intake and green-and-ready.

### Gated issues

The agent pauses at the **first human-judgment point** and notifies the human:

- **UI (B1):** pause **after** the PR is green-and-ready, surfacing the visual
  proof for the human's eyeball-assert. (The work is correct-by-CI; only the
  *look* needs a human.)
- **Risk-surface (B2):** pause **earlier** — at the spec/plan review gate (T2/T3)
  or before opening the PR (T1) — because the judgment needed is on the
  *approach*, not just the result. The agent flags the PR (label + a "do not
  merge — awaiting gate" marker) and notifies the human; merge is held by the
  human-merge boundary.

### Notification (minimum bar)

The agent MUST, at minimum, **post a comment on the issue tagging the assignee**
at green-and-ready and at each gate — a fire-and-forget comment on a quiet issue
is not sufficient on its own. The runbook may strengthen this (review-request,
assignment, external ping). **Staleness:** PRs parked at a gate are not silently
abandoned — the runbook defines a re-ping/escalation policy and a tracking
surface listing all PRs awaiting human action, so the hands-off promise does not
degrade into "work piles up where no one is looking."

### Comment loop

After publish, `pr-autopilot` drives the reviewer-bot / CI feedback loop to
quiescence (per **Terms**, bounded at 3 cycles). Late human or bot comments
arriving after quiescence are handled by re-entering the loop with `pr-followup`.

## Abort / escalation conditions

The agent stops and asks the human when any of these occur:

- Bug cannot be reproduced reliably, even statistically (intake).
- Acceptance criteria ambiguous/absent and not confidently inferable into
  checkable form.
- A surviving `ce-doc-review` finding requires a product decision the agent
  cannot make; or `ce-doc-review` is unavailable (treat the stage as gated).
- CI stays red after **3** `pr-autopilot` iterations on a cause the agent cannot
  fix.
- The change is discovered (by the agent's pre-PR re-check) to touch a risk
  surface → re-classify as gated and route to the human gate.

## Deliverables

The deliverable is documentation only — a guidance runbook plus the index wiring
the repo's doc-maintenance contract requires. **No `.yml`, no scripts, no CI
checks.**

| Artifact | Action |
|----------|--------|
| `.ai/docs/issue-resolution-workflow.md` | New runbook — agent-facing operational version of this design: the two-axis decision tree, the risk-surface table, the triage-comment / `## Proof` / notification templates, the per-tier pipelines, the abort/escalation list, and the quiescence/iteration definitions. |
| `CLAUDE.md` | Add the runbook to the shared-rules link table **and** record the gate-substitution authorization (the hands-off override is in force once this lands). |
| `.ai/README.md` | Add the runbook to the doc index table. |
| `.cursor/rules/` | Wire the runbook so Cursor consumes the same content. |
| `.ai/docs/documentation-maintenance.md` | Add a row: runbook kept in lockstep with the workflow. **Add a second row:** any change to `architectural-invariants.md` (or to the risk-surface code directories) triggers a mandatory review of the risk-surface table in the runbook, plus a scheduled (e.g. monthly) re-audit — code can drift a surface into a new directory without touching the invariants file. |
| `docs/specs/README.md` | Index this spec + its deferrals sidecar. |

### Deferred / rejected (not pursued)

Mechanical enforcement was considered and **not built** (recorded in the deferrals
sidecar; revisit only if autonomy increases beyond "human merges every PR" or more
agents are assigned): an advisory or required CI risk-classification check, a
`secrets-scan.yml` workflow, branch protection / `required_status_checks`
registration, `required_approving_review_count ≥ 1` + `CODEOWNERS`, a separate
approver identity, and a red-baseline CI job. This iteration ships guidance only.

## Resolved & open questions

- **RESOLVED — OPEN DECISION 1 (hands-off T3):** hands-off extends to net-new T3
  behavior; `ce-doc-review` substitutes for the human spec/plan gate, bounded by
  the human merge. The body reflects this.
- **RESOLVED — OPEN DECISION 2 (enforcement model):** guidance + human-merge; no
  CI check, no enforcement tooling (see Deferred/rejected, above).
- **The risk-surface table is the single point of failure**, and it is partial by
  construction (behavioral surfaces have no obvious signal). Mitigations: the
  Axis-B "when in doubt, gate" default, the scheduled re-audit doc-maintenance
  trigger, the agent's pre-PR re-check, and — ultimately — the human merge that
  sees every PR. There is no automated backstop, by design. Note the
  `/code-review` bot is **not** an independent backstop either: it is the same
  Claude model that performed the fix, so its blind spots correlate with the
  fixer's.
- **Tier boundaries are fuzzy.** Mitigated by the escalate-up tie-break rule.
- **Minimum agent capability.** Self-classification reliability varies across
  agent implementations; the runbook should state a minimum-capability
  expectation for any agent assigned hands-off work, since (with no CI enforcement)
  the safety property leans entirely on the agent's classification plus the human
  merge.
