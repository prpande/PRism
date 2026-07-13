# Issue-resolution workflow

How any agent works an assigned GitHub issue in this repo: classify it, fix it,
prove the fix, and drive the PR to green — hands-off by default, pausing for a
human only when the change needs human judgment.

**This is guidance, not enforcement.** There is no CI check and no `.yml` behind
it. You classify your own change against the tables below, record the
classification in your triage comment, and — for gated changes — pause and notify
the human. **The human merge is the safety boundary**, except inside the narrow
envelope of [§ Delegated merge authority](#delegated-merge-authority-bounded-self-merge).

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
  agent's classification plus the human merge — and, inside the
  § Delegated merge authority envelope, on the classification plus that section's
  compensating controls alone.

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

If the issue is claimed and the claim is **fresh** (see Fresh vs. stale below),
**do not pick it up** — choose a different issue.

**To claim an issue:** at intake, **before reproduction** (decision-tree step 0):

1. **Self-assign** the issue, **and**
2. add the **`in-progress`** label.

These two actions *are* your binding claim, and they happen before you invest in
reproduction. The triage comment (§ Triage-comment template) is **not** part of
the at-intake claim — it lands later at **step 4**, once you have classified the
issue, and only fills in the human-readable detail behind a claim you already
staked.

Then **re-read the issue.** GitHub assignees are **multi-valued** — self-assigning
*adds* you, it does not evict an existing assignee — so two agents claiming
near-simultaneously end up **co-assigned**, each visible to the other. That
visibility is the tie-breaker: if, after claiming, you find another agent also
assigned, the **earlier** claimant wins — back off and pick another issue. To
decide who was earlier, compare **assignee-list order** (GitHub preserves
insertion order), falling back to triage-comment timestamp only if one already
exists (at step 0 it usually won't). This shrinks the check-then-claim race but
does not eliminate it; the human (who ultimately merges) is the final backstop
against duplicate work — which is why condition 2 of § Delegated merge authority
bars self-merging an issue that carries **another agent's** claim (assignee or
triage comment): on a self-merged PR that backstop never fires, so a *contested*
issue must go to the human. Your own solo claim is not a contest and does not bar
self-merge.

**Fresh vs. stale.** A claim is **fresh** — leave it alone — unless it is
**stale**. A claim is **stale (reclaimable)** only when it shows **no sign of
active work for ~2 working days**: no new triage/progress comment, no linked open
PR, *and* no recent commits on a branch linked to the issue. The inactivity test
matters because a legitimate T3 claim can run for days before a PR exists — the
absence of a PR alone is **not** staleness. Before reclaiming a stale claim, post a
comment noting the takeover and re-assign to yourself so the original agent (if
still alive) sees it. This mirrors the gate-staleness re-ping under § Notification
(minimum bar) and keeps a dead claim from starving an otherwise-available issue.

> **Prerequisite:** the repo needs an `in-progress` label. Create it once
> (guarded with an exact-name match so it is safe to re-run):
> `gh label list --json name --jq '.[].name' | grep -qx in-progress || gh label create in-progress`.
> Already created in `prpande/PRism`.

**Releasing the claim.** The claim is released when the issue **closes** — the
counterpart to staking it at step 0. You do not remove `in-progress` by hand on
the happy path: the `unclaim-on-close.yml` workflow strips it automatically on
the `issues: closed` event (a merged fix's `Closes #N` triggers the close). This
is label hygiene, not a gate, so it does not change the "no CI enforcement"
stance for tiers/risk. It also covers issues closed for any other reason
(won't-fix, duplicate), so a closed issue never keeps claiming to be in flight.
If that workflow is ever disabled, remove `in-progress` by hand as the last
cleanup step (see decision-tree step 11).

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
10. Notify the human (§ Notification template). The human merges — unless the
    change clears every condition in § Delegated merge authority, in which case
    you merge, then notify.
    (UI: pause for the visual assert. Risk-surface: you paused earlier.)
11. Un-claim on completion: when the issue closes (the merged fix's `Closes #N`
    closes it), the `in-progress` label is removed automatically by the
    `unclaim-on-close.yml` workflow. This is label hygiene, not a gate. If you
    do any post-merge cleanup, confirm `in-progress` is gone; if that workflow is
    ever disabled, remove it by hand — a closed issue must never keep the claim.
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
here too. This is a self-check; the human merge is the only backstop behind it —
and on a self-merged PR (§ Delegated merge authority) it is *condition 5*, with no
backstop behind it at all. Read the diff, not your memory of it.

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
the human merge is the backstop. Where you intend to self-merge
(§ Delegated merge authority), that backstop is gone: the two-lens adversarial
gate-check replaces it, and a B2 surface is disqualifying outright.

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
### Self-merge authority (self-merged PRs only)
<the six conditions of § Delegated merge authority, each with how it was satisfied,
 including both adversarial reviewers' verdicts>
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
- **Self-merge authority** is required on every PR the executor merges itself, and
  MUST be absent otherwise. See § Delegated merge authority.

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
touch a risk surface, bounded by the human merge. That bound is load-bearing —
which is why § Delegated merge authority forbids self-merging a T3 outright. The
human merge is what makes gate substitution's residual risk survivable.

**Fallback:** if `ce-doc-review` is unavailable in the session, the substitute
sign-off doesn't exist — **treat that stage as gated** and request a human review.
Do not proceed hands-off on an unsigned spec/plan.

## Gates & terminal action

**Hands-off (non-gated):** intake → pipeline → `pr-autopilot` drives to
green-and-ready → **stop and notify the human** with the PR link + proof summary.
The human does the one-click merge, unless § Delegated merge authority applies.
No pause in between.

**Gated:** pause at the **first human-judgment point**:

- **UI (B1):** pause **after** green-and-ready, surfacing the visual proof for the
  human's eyeball-assert. (Correct-by-CI; only the *look* needs a human.)
- **Risk-surface (B2):** pause **earlier** — at the spec/plan gate (T2/T3) or
  before opening the PR (T1) — because the judgment needed is on the *approach*.
  Flag the PR (label + a "do not merge — awaiting gate" marker) and notify the
  human; merge is held by the human-merge boundary.

## Delegated merge authority (bounded self-merge)

On 2026-07-10 the repository owner delegated a **bounded** merge authority to the
reference executor, for autonomous tech-debt work. It is a narrow exception to
"the human merge is the safety boundary," not a replacement for it. The envelope
below limits what a misclassification can damage; the adversarial gate-check in
condition 3 hardens the classification itself.

**You may merge your own PR only when ALL six conditions hold.** Any one failing
condition returns the PR to the default path: drive it to green-and-ready, stop,
and notify the human.

1. **Actionable.** Not an epic, not blocked, not a duplicate, not `needs-slicing`.
2. **No competing claim.** No assignee other than you, and no other agent's triage
   comment (§ Claiming an issue) — a competing claim always surfaces as one of
   those, since a claim is self-assign + label together. Your own step-0 claim does
   **not** disqualify you: condition 2 guards against *another actor's* duplicate
   work, and a claim you placed and never shared carries none of that risk. So the
   bare `in-progress` label alone is not disqualifying; a *contested* issue (another
   agent co-assigned or commented) is — hand that to the human.
3. **Hands-off after a 2-lens adversarial gate check.** Beyond the ordinary Axis-B
   read, run two independent reviewers whose brief is to *refute* the hands-off
   call — one arguing B1 (UI-visual), one arguing B2 (risk-surface). A refutation
   at medium or high confidence flips the issue to gated.
4. **Green is a trustworthy signal for this change.** It is not, for instance, on
   a flaky-test fix (green proves nothing about the flake) or on an unmeasured
   performance claim (green proves nothing about the speed-up).
5. **The pre-PR-open re-check found zero risk surfaces** in the *actual committed
   diff* — not in the plan, not in the intent.
6. **All checks pass.** `gh pr checks <N>` reports zero failing and zero pending.

**Two absolutes sit above the six conditions.** Neither can be traded against a
condition, and no amount of green satisfies either.

- **Never self-merge a B2 risk-surface change.** Condition 3 exists to catch a B2
  you misread as hands-off; this rule is what remains standing if condition 3
  fails too.
- **Never self-merge a T3.** § Gate substitution lets you walk past the human
  spec/plan review, and the design spec accepts that residual on one stated
  condition: *"the human still performs the merge, so the worst case is 'a human
  merges a PR whose approach they would have steered differently' → rework, not a
  silent production change."* Self-merging a T3 would compound the two
  authorizations and void that bound — no independent party would read the spec,
  and none would read the diff. Condition 3's adversarial lenses test the *risk
  surface*, not the *approach*, so they cannot backfill the gate substitution
  already removed. A hands-off T3 goes to the human's merge queue, green and
  ready.

**Why condition 6 names `gh pr checks` and not `mergeable`.** `main`'s ruleset
lists exactly one required status check — `build-and-test`. The `e2e` and
`desktop` jobs are **not** required. GitHub therefore reports `mergeable:
MERGEABLE` / `mergeStateStatus: CLEAN`, and lights the merge button, on a PR whose
`e2e` job is **red**. `mergeable` answers "will GitHub let this merge," never "is
this change correct"; only the full check list answers the latter. (The ruleset
also sets `strict_required_status_checks_policy`, so merges are strictly serial —
each merge invalidates the next PR's required check and forces a re-sync.)

**Everything else** — every gated issue, every issue where green is not a
trustworthy signal, every issue whose diff surprised you at the pre-PR re-check —
follows the unchanged path in § Gates & terminal action: drive to green-and-ready
and hand the human a one-click merge.

**Record it.** A self-merged PR's `## Proof` MUST carry a `### Self-merge
authority` block naming each of the six conditions and how it was satisfied,
including both adversarial reviewers' verdicts. That block is the audit trail that
stands in for the human glance. Notify the human **after** merging
(§ Notification), so the merge is never silent.

## Notification (minimum bar)

At green-and-ready and at each gate, you MUST **post a comment that @-mentions the
assignee**. The @-mention is the required minimum — it is what generates a
notification; a comment without it can sit unseen on a quiet issue. Stronger
signals (a review-request, an assignment, an external ping) are encouraged on top,
but the @-mention is the floor.

```markdown
@<assignee> — <PR #> is <green-and-ready | awaiting your gate (B<n>) | merged under § Delegated merge authority>.
Tier T<n>, <risk>. Proof: <link to ## Proof>. Action needed: <merge | review approach | visual assert | none — FYI>.
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

- **Green-and-ready** — CI green (**every** check `gh pr checks <N>` reports
  passes — not merely the *required* ones; see § Delegated merge authority) **and**
  `/code-review` bot **quiescent** **and** the `## Proof` section complete. The
  terminal state of every hands-off run.
- **Quiescent** — one full CI + `/code-review` cycle completes with **zero new
  actionable bot comments** after the latest push. Because the bot is a
  non-deterministic LLM review that re-runs on every push, the loop is bounded:
  after **3** consecutive address→push→re-review cycles that still surface new
  actionable comments, escalate to the human rather than looping further.
  (`pr-autopilot` owns the loop; this is the terminal condition it drives toward.)
