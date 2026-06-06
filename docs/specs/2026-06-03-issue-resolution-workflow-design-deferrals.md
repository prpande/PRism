---
source-doc: docs/specs/2026-06-03-issue-resolution-workflow-design.md
created: 2026-06-03
last-updated: 2026-06-03
status: open
---

## [Skip] All mechanical enforcement, including any CI risk-classification check

- **Source:** `ce-doc-review` round-2 pass on 2026-06-03 (feasibility, security-lens, adversarial; several findings verified at confidence 100 against the live repo ruleset), followed by an explicit maintainer decision on 2026-06-03 to ship guidance only.
- **Severity:** P1
- **Date:** 2026-06-03
- **Reason:** Round 2 verified that a round-1 "deterministic, agent-independent" CI gate over-claimed: `main` has no branch protection requiring a check, `required_approving_review_count` is `0`, there is no `CODEOWNERS`, and the executor agent has write access (so it could apply its own gated label and self-clear). The design was first softened to an *advisory* CI check + human merge, and then the maintainer decided to drop the CI check entirely: **the end result is a single guidance markdown runbook, with no `.yml`, no scripts, and no additional CI checks.** The agent self-classifies against the runbook's risk-surface table, records the classification in its triage comment, and the human merge — which already reviews every PR — is the sole safety boundary. Rationale: for a single-maintainer PoC the human merge is sufficient, and enforcement tooling carries standing maintenance cost with correlated/limited value (the only available CI reviewer is the same Claude model that authored the fix).
- **Skipped artifacts:** advisory or required CI risk-classification check (`risk-classification.yml`), the supporting classification scripts, a `secrets-scan.yml` workflow, branch-protection / `required_status_checks` registration, `required_approving_review_count ≥ 1` + `CODEOWNERS`, a separate approver identity, and a red-baseline CI job.
- **Revisit when:** autonomy increases beyond "human merges every PR" (e.g. auto-merge is ever introduced), OR multiple/heterogeneous agents are assigned issues such that the human merge stops being a reliable per-PR checkpoint, OR issue volume makes per-PR human review impractical.
- **Original finding evidence:** "Ruleset 15992453 required_status_checks: [{\"context\":\"build-and-test\"}] — risk-classification absent"; "required_approving_review_count: 0, required_reviewers: []"; "the same agent that gated a change can apply the label … self-clearing is unprevented." Maintainer: "the end result of this effort is a simple md file to guide the agent we do not need a yml file to enforce any additional checks."

## [Skip] Restrict hands-off to T1/T2 (keep a human approach gate for all T3)

- **Source:** `ce-doc-review` round-1 (product-lens P1, adversarial P2, security-lens P2) — machine `ce-doc-review` is a weaker substitute than the human spec/plan gate for net-new T3 approach errors
- **Severity:** P1
- **Date:** 2026-06-03
- **Reason:** Raised as OPEN DECISION 1. The maintainer chose to **allow hands-off T3**: `ce-doc-review` substitutes for the human spec/plan gate on non-gated T3, accepting the residual that no human evaluates the *approach* until the merge click. The accepted bound is the human merge — worst case is a human merging a PR whose approach they'd have steered differently (rework), not a silent production change. Restricting to T1/T2 was explicitly rejected in favor of maximum hands-off autonomy.
- **Revisit when:** n/a (rejected with reasoning; revisit only on new evidence that hands-off T3 produces materially costly rework).
- **Original finding evidence:** "Substituting the machine pass for the human gate on net-new T3 behavior means no independent party evaluates the approach before the PR is merge-ready."

## [Skip] Auth/token-specific extra proof item in the proof contract

- **Source:** `ce-doc-review` round-1 (security-lens P2)
- **Severity:** P2
- **Date:** 2026-06-03
- **Reason:** Proposed an extra proof item (PAT-scope / token-storage invariants demonstrated unchanged) for auth-surface changes. Skipped: auth / PAT-scope / token-storage is a **B2 risk surface**, so any such change is **gated** — a human reviews the approach directly. Adding a surface-specific proof item on top of the human gate is redundant for the gated path and would over-engineer the contract. The generic proof contract (red-on-main, acceptance checklist, secrets scan) plus the human gate already covers it.
- **Revisit when:** n/a (rejected; revisit only if auth changes are ever moved off the gated path).
- **Original finding evidence:** "for changes that touch the auth or token-storage surface, it does not require any proof that token handling semantics are preserved."
