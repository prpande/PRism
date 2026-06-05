# Issue-resolution workflow

How any agent works an assigned GitHub issue in this repo: classify it, fix it,
prove the fix, and drive the PR to green — hands-off by default, pausing for a
human only when the change needs human judgment.

**This is guidance, not enforcement.** There is no CI check and no `.yml` behind
it. You classify your own change against the tables below, record the
classification in your triage comment, and — for gated changes — pause and notify
the human. **The human merge is the safety boundary.**

Rationale and rejected alternatives: see
[`docs/specs/2026-06-03-issue-resolution-workflow-design.md`](../../docs/specs/2026-06-03-issue-resolution-workflow-design.md)
and its deferrals sidecar.

## When this applies

You have been assigned a GitHub issue in this repo (`prpande/PRism`).

- **Reference executor:** a Claude Code session (or equivalent CLI agent)
  **running with repository write access** — the only agent class that can create
  branches, push commits, apply labels, post comments, and open PRs while invoking
  the skills the pipelines name.
- **`@claude` mentions are advisory only.** They run with read-only scope and
  **cannot author the fix or the PR** — they answer questions and suggest
  approaches on an existing issue/PR. They do not execute this workflow.
- **Minimum capability** for any agent assigned hands-off work: it must be able to
  read the codebase, run the full test suite, and reason about the risk-surface
  table below. With no CI enforcement, the safety property leans entirely on the
  agent's classification plus the human merge.

## Claiming an issue (before you start)

Before you invest any work in an issue — including reproduction — confirm no other
agent is already working it, then stake your own claim. This is the
**distributed** guard against two agents (on this machine or any other) picking up
the same issue: the claim lives on the issue itself, visible to every agent
everywhere, not in a local worktree that only this machine can see.

**An issue is already claimed if any of these hold:**

- it has an **assignee** other than you, **or**
- it carries the **`in-progress`** label, **or**
- it has a triage comment (§ Triage-comment template) from another agent.

If the issue is claimed *and the claim is fresh* (see Staleness below), **do not
pick it up** — choose a different issue.

**To claim an issue** (do this at intake, before reproduction):

1. **Self-assign** the issue.
2. Add the **`in-progress`** label.
3. Post the triage comment (§ Triage-comment template) once you have classified it
   — this is the human-readable detail behind the claim.

Self-assign **first**: the assignee is a single GitHub field, so it is the
**tie-breaker** when two agents claim near-simultaneously — the later write wins,
and an agent that finds its own assignment overwritten must back off and pick
another issue. The label and comment are for discovery and humans; the assignee
settles races. This shrinks the check-then-claim race but does not fully eliminate
it; the human (who ultimately merges) is the final backstop against duplicate
work.

**Staleness / abandonment.** A claim is **reclaimable** if it is older than ~2
working days **and** has no linked open PR (or its linked PR is closed unmerged) —
the claiming agent has crashed or walked away. Before reclaiming, post a comment
noting the takeover and re-assign to yourself, so the original agent (if still
alive) sees it. This mirrors the gate-staleness re-ping under § Notification and
keeps a dead claim from starving an otherwise-available issue forever.

> **Prerequisite:** the repo needs an `in-progress` label. Create it once with
> `gh label create in-progress` if it does not already exist.

## The decision tree

```
0. Claim: confirm the issue is unclaimed (§ Claiming an issue) and stake your
   claim (self-assign + `in-progress` label) BEFORE investing in reproduction.
   If it's already claimed and the claim is fresh, pick a different issue.
1. Reproduce (bug) / restate the ask (feature). Establish acceptance criteria.
   HARD STOP if the bug can't be reproduced (even statistically), or the
   acceptance criteria can't be made concrete enough to check.
2. Classify TIER: T1 / T2 / T3.            (When borderline, escalate UP a tier.)
3. Classify RISK: gated vs hands-off.      (When in doubt, GATE.)
4. Post the triage comment (§ Triage-comment template).
5. Create an isolated worktree + branch (git worktree add <path> -b <branch>).
6. Run the tier pipeline, pausing at the [risk gate] iff the change is gated.
7. Pre-PR re-check: re-read the diff against the risk table. If you touched a
   surface you didn't gate at intake, re-classify to gated and route to the human.
8. Assemble the ## Proof section (§ Proof template).
9. pr-autopilot → green-and-ready.
10. Notify the human (§ Notification template). The human merges.
    (UI: pause for the visual assert. Risk-surface: you paused earlier.)
```

## Tier (Axis A) — how much ceremony

Tier scales with size, blast radius, and design judgment. It does **not** depend
on risk (that is Axis B).

| Tier | Trigger | Pipeline (summary) |
|------|---------|--------------------|
| **T1 — Direct** | Small, localized fix with a clear reproduction. Roughly one file of production change; no meaningful design choice. (e.g. a stale-lock bug, a flaky-test fix, an off-by-one.) | regression test (red on `main`) → fix → PR. No spec, no plan. |
| **T2 — Light** | Medium change touching ~2–4 files, or one real design choice, but still a single coherent unit of work. | (bug: red-on-main test first) → short spec (1× `ce-doc-review`) → TDD execute → PR. No separate plan. |
| **T3 — Full** | Slice-sized work, genuinely new behavior, or cross-cutting change. The repo's standard path. | `brainstorming` → spec → 2× `ce-doc-review` → `writing-plans` → plan → 2× `ce-doc-review` → `executing-plans` (TDD) → PR. |

**Tie-break: when a change sits on a T1/T2 or T2/T3 boundary, escalate up a
tier.** Misclassification must fail toward *more* rigor, never less.

## Per-tier pipelines

`[risk gate]` means: **if the change is gated (B1/B2), pause for the human here;
if hands-off, proceed.**

**T1 — Direct fix**
```
reproduce
→ write regression test; run it; confirm RED on main (capture failing output)
→ implement the minimal fix
→ test GREEN; full local pre-push checklist (.ai/docs/development-process.md)
→ [risk gate — gated: notify human BEFORE opening PR]
→ pr-autopilot
```

**T2 — Light**
```
(bug work: reproduce → regression test RED on main first)
→ write a short spec → docs/specs/YYYY-MM-DD-<topic>-design.md
→ 1× ce-doc-review → apply surviving findings (receiving-code-review rigor)
→ [risk gate — gated: notify human on the SPEC/approach before TDD]
→ TDD execute (red → green per behavior)
→ local pre-push checklist
→ pr-autopilot
```

**T3 — Full (the repo's standard path)**
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

**Pre-PR-open re-check (all tiers).** Immediately before opening the PR, re-read
the actual committed diff against the Axis-B table and compare it to your intake
classification. A discrepancy (a risk surface touched that you didn't gate at
intake) forces the issue to gated and routes to the human gate. Re-check UI (B1)
here too. This is a self-check; the human merge is the only backstop behind it.

## Risk (Axis B) — whether a human gate fires

A change is **gated** (pauses for the human) if it meets *either* condition below.
Otherwise it is **hands-off**.

**Tie-break: when in doubt, gate.** Under-gating is the catastrophic direction (an
unsupervised change to a sensitive surface); a false-positive gate costs only one
human glance. If you are less than confident a change is clear of every surface
below, gate it.

**B1 — UI-visual.** The issue carries the `design` or `needs-design` label, OR the
change alters rendered output whose correctness a human must eyeball (layout,
spacing, color, typography, motion, copy, component composition). CI cannot assert
"looks right," so a human must.

**B2 — Risk-surface.** The change touches one of the following surfaces. Most are
anchored to [`architectural-invariants.md`](architectural-invariants.md); the
cross-tab stamp and the standalone security surface anchor to their own design
specs and `behavioral-guidelines.md` §6. The
*signals* column gives you concrete things to look for — they are **heuristics for
your judgment**, not mechanical rules. Some surfaces (behavioral invariants) have
no reliable path/symbol footprint, so when in doubt, gate.

| Risk surface | Signals to look for |
|--------------|----------------------|
| Auth / PAT scopes / token storage | Token-storage paths; PAT-scope *validation logic* (lives in generically-named files, e.g. submit/reconciliation pipelines); symbols like `RequiredScope`/`PatScope`/`TokenStore`/MSAL cache; `area:auth` label. |
| Reviewer-atomic submit pipeline | The pending-review GraphQL pipeline (`addPullRequestReview` → thread/reply → `submitPullRequestReview`); `pendingReviewId`/`threadId`/`replyCommentId`/`prism:client-id`. |
| Data migrations / persisted schema | `state.json` read/write and migration logic (spread across multiple files); schema/migration symbols. |
| Cross-tab stamp / poisoning protocol | The `TabStamp` type and stamp/poisoning-guard logic. |
| Desktop sidecar seams | `SidecarMode`, `ParentLivenessProbe`/`Watchdog`, `HostHeaderCheckMiddleware`, the `127.0.0.1` bind; `area:desktop` label. |
| Architectural invariants | Any change touching a decision in `architectural-invariants.md`, including behavioral ones (`Banner, not mutation`; `Truthful by default`; Octokit source-hygiene; kebab-case enums; opaque Node IDs) that have no stable path footprint — when unsure, gate. |
| Security surface | Host-header check, bind address, secret/credential handling; `behavioral-guidelines.md` §6. |

**How you apply this (no tooling).** Read the change against the table, decide
hands-off vs gated, and **record the decision and its reason in your triage
comment**. There is no CI check that re-computes or enforces this — the
classification is yours, surfaced for the human, and the human merge is the
boundary. The "when in doubt, gate" rule protects against gaps in your judgment;
the human merge is the backstop.

## Triage-comment template

Post this on the issue at intake (step 4):

```markdown
## Triage
- **Tier:** T<n> — <one-line why>
- **Risk:** <hands-off | gated: B1 UI | gated: B2 [surface]> — <one-line why>
- **Acceptance criteria:** <restated, checkable>
- **Approach:** <2–4 sentences>
```

## Proof template

The PR body MUST contain a `## Proof` section. Include the parts that apply:

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

Proof rules:

- **Red-on-main (bug fixes):** capture the regression test **failing** against a
  clean `origin/main` checkout *before* the fix, alongside it passing on the PR
  head. Paste commit-pinned local output (there is no CI job for this). For
  statistical/concurrency bugs, "red-on-main" means the test reds reliably under a
  defined retry/stress budget, not on a single run. Without verifiable
  red-on-main, the test doesn't prove the bug existed — the fix is **not** done.
- **Non-bug work** (enhancements/tech-debt): the proof is the new tests authored
  test-first (red → green within the PR's history) plus the acceptance checklist.
- **Secrets scan** is required on **every** PR (gate substitution removes the
  human pass that would otherwise catch a leaked credential). Self-attested per
  `behavioral-guidelines.md` §6.
- **Green CI** is enforced by `pr-autopilot`'s terminal gate (see Terms); it is
  not pasted as a separate artifact.

## Gate substitution (the core hands-off mechanism)

`brainstorming` and `writing-plans` bake in human-review gates ("ask the user to
review the spec/plan first"). `CLAUDE.md` also requires a human pass after
`ce-doc-review`.

For **hands-off (non-gated)** issues, **proceed past those human gates without
pausing** — the machine `ce-doc-review` pass (2× for T3, 1× for T2) is the
substitute sign-off. Record in the PR's `## Proof` that you did so, surfacing
every `ce-doc-review` finding with its disposition (Applied / Deferred / Skipped +
one-line reason). This is authorized by `CLAUDE.md`. It applies **only** to
non-gated issues; gated issues keep the human gates.

Hands-off **T3 is in scope**: net-new behavior runs hands-off when it doesn't
touch a risk surface, bounded by the human merge.

**Fallback:** if `ce-doc-review` is unavailable in the session, the substitute
sign-off doesn't exist — **treat that stage as gated** and request a human review.
Do not proceed hands-off on an unsigned spec/plan.

## Gates & terminal action

**Hands-off (non-gated):** intake → pipeline → `pr-autopilot` drives to
green-and-ready → **stop and notify the human** with the PR link + proof summary.
The human does the one-click merge. No pause in between.

**Gated:** pause at the **first human-judgment point**:

- **UI (B1):** pause **after** green-and-ready, surfacing the visual proof for the
  human's eyeball-assert. (Correct-by-CI; only the *look* needs a human.)
- **Risk-surface (B2):** pause **earlier** — at the spec/plan gate (T2/T3) or
  before opening the PR (T1) — because the judgment needed is on the *approach*.
  Flag the PR (label + a "do not merge — awaiting gate" marker) and notify the
  human; merge is held by the human-merge boundary.

## Notification (minimum bar)

At green-and-ready and at each gate, you MUST **post a comment that @-mentions the
assignee**. The @-mention is the required minimum — it is what generates a
notification; a comment without it can sit unseen on a quiet issue. Stronger
signals (a review-request, an assignment, an external ping) are encouraged on top,
but the @-mention is the floor.

```markdown
@<assignee> — <PR #> is <green-and-ready | awaiting your gate (B<n>)>.
Tier T<n>, <risk>. Proof: <link to ## Proof>. Action needed: <merge | review approach | visual assert>.
```

**Staleness:** PRs parked at a gate are not silently abandoned — re-ping after
~2 working days, and keep a tracking note of all PRs awaiting human action so the
hands-off promise doesn't degrade into "work piles up where no one is looking."

## Comment loop

After publish, `pr-autopilot` drives the reviewer-bot / CI feedback loop to
quiescence (bounded at 3 cycles — see Terms). Late human or bot comments arriving
after quiescence are handled by re-entering the loop with `pr-followup`.

## Abort / escalation conditions

Stop and ask the human when any of these occur:

- Bug cannot be reproduced reliably, even statistically (intake).
- Acceptance criteria ambiguous/absent and not confidently inferable into
  checkable form.
- A surviving `ce-doc-review` finding requires a product decision you cannot make;
  or `ce-doc-review` is unavailable (treat the stage as gated).
- CI stays red after **3** `pr-autopilot` iterations on a cause you cannot fix.
- Your pre-PR re-check discovers the change touches a risk surface → re-classify
  as gated and route to the human gate.

## Terms

- **Green-and-ready** — CI green (all required workflows pass) **and**
  `/code-review` bot **quiescent** **and** the `## Proof` section complete. The
  terminal state of every hands-off run.
- **Quiescent** — one full CI + `/code-review` cycle completes with **zero new
  actionable bot comments** after the latest push. Because the bot is a
  non-deterministic LLM review that re-runs on every push, the loop is bounded:
  after **3** consecutive address→push→re-review cycles that still surface new
  actionable comments, escalate to the human rather than looping further.
  (`pr-autopilot` owns the loop; this is the terminal condition it drives toward.)
