---
source-doc: docs/specs/2026-05-28-v1-completion-roadmap-design.md
plan-doc: docs/plans/2026-05-28-v1-completion-roadmap.md
created: 2026-05-28
last-updated: 2026-05-28
status: resolved
revisions:
  - 2026-05-28: created during PR #84 review pass to record the 6 ce-doc-review findings that were skipped (not applied) during the spec + plan review cycles. All 6 are non-applicable per the false-positive / pedantic-folded categories in the ce-doc-review false-positive catalog; recorded for institutional memory and to satisfy the documentation-maintenance policy that requires a deferrals sidecar when ce-doc-review surfaces rejected alternatives.
---

# Deferrals — v1 completion roadmap

This sidecar records the 6 `ce-doc-review` findings that surfaced during the spec (5-persona) and plan (2-persona) review passes and were **not** applied. Every entry here is a `[Skip]` — none of these are deferred-for-later items. Status `resolved` because each was triaged and acted on (or explicitly not acted on with reason) during the same PR cycle.

The spec + plan review pipeline applied ~25 findings on the spec and 4 on the plan; that work landed in the spec/plan files themselves. This sidecar captures only the rejections so future readers can see what was weighed and why each item didn't land.

---

## Spec review — 5-persona ce-doc-review pass (2026-05-28)

### [Skip] COH-004 — Inconsistent link-style across cross-references

- **Source:** `ce-doc-review` coherence-reviewer persona on 2026-05-28 (spec pass).
- **Severity:** P3 — advisory style.
- **Date:** 2026-05-28
- **Reason:** Reviewer flagged that the spec mixes bare-string path references (in the source-authority block) with full markdown-link form (everywhere else). This matches the ce-doc-review false-positive catalog item "pedantic style nitpicks (word choice, bullet vs. numbered lists, comma-vs-semicolon, em-dash vs en-dash) — style belongs to the document author." The mix is intentional: the source-authority block reads as a citation list, where bare paths read better; body prose uses live markdown links. No reader confusion is plausible.
- **Revisit when:** n/a — Skip.
- **Original finding evidence:** "The document mixes relative-path and markdown-link styles inconsistently. Lines 6, 9, 50 use bare path strings like `docs/specs/...` without brackets or link syntax. Lines 18, 89, etc. use full markdown-link syntax..."

### [Skip] COH-005 — § 4.4 "amend" language is allegedly ambiguous

- **Source:** `ce-doc-review` coherence-reviewer persona on 2026-05-28 (spec pass).
- **Severity:** P2 — alleged contradiction.
- **Date:** 2026-05-28
- **Reason:** Reviewer claimed § 4.4 has contradictory readings on whether post-merge amend of Phase 2's commit is permitted. Re-reading the actual § 4.4 text after the in-flight inline fix that landed earlier in the review cycle: the parenthetical ("Phase 2 ships with 'v0.1.0 prepared' wording deliberately; the truth-state flip waits on real binary verification") explains *why* it's a separate PR, not that amend is allowed. Reviewer was reading an outdated draft that no longer existed at finding-emission time. The current text is unambiguous.
- **Revisit when:** n/a — Skip.
- **Original finding evidence:** "The phrase 'never an amend to Phase 2's merged commit' forbids post-merge commit amending. However, the parenthetical clarification implies an 'OR amend' reading..."

### [Skip] F-3 — S6 polish-and-distribution spec needs promotion to "Implemented"

- **Source:** `ce-doc-review` feasibility-reviewer persona on 2026-05-28 (spec pass).
- **Severity:** P2 — alleged missing sweep item.
- **Date:** 2026-05-28
- **Reason:** Reviewer suggested adding a row to spec § 3.3 to promote `2026-05-15-s6-polish-and-distribution-design.md` from "In progress" to "Implemented". Verified by grep — the entry is already in the "Implemented" group at `docs/specs/README.md:18` (has been since 2026-05-27 per the S6 PR9 / PR #82 merge). False positive; the reviewer didn't check the actual current state of the file. Other genuinely-stale "In progress" entries (added in iter 2 of the review cycle via claude[bot]'s catch) are spelled out in spec § 3.3.
- **Revisit when:** n/a — Skip (false positive).
- **Original finding evidence:** "The S6 polish-and-distribution design at `docs/specs/2026-05-15-s6-polish-and-distribution-design.md` is the parent design for the entire S6 slice... § 3.3 only amends its body without flipping its status."

### [Skip] SG-05 — `docs/backlog/` link target may 404

- **Source:** `ce-doc-review` scope-guardian persona on 2026-05-28 (spec pass).
- **Severity:** P2 — alleged broken link.
- **Date:** 2026-05-28
- **Reason:** Reviewer flagged that the spec's § 3.1 README structure table mentions `docs/backlog/` for the Roadmap section, but couldn't verify the directory exists. Verified by `ls D:/src/PRism/docs/backlog/` — directory exists with 4 P-tier files (`00-priority-methodology.md`, `01-P0-foundations.md`, `02-P1-core-ai.md`, `03-P2-extended-ai.md`, `05-P4-polish.md`). Link is valid.
- **Revisit when:** n/a — Skip (false positive).
- **Original finding evidence:** "The spec links to `docs/backlog/` in the README's Roadmap section, but no `docs/backlog/` directory is referenced anywhere... if the directory does not exist, the link is a 404 in the published README at the v0.1.0 tag."

### [Skip] PL-08 — Phase 2 should split into 2a/2b

- **Source:** `ce-doc-review` product-lens persona on 2026-05-28 (spec pass).
- **Severity:** P2 — recommendation, not requirement (reviewer's own framing).
- **Date:** 2026-05-28
- **Reason:** Reviewer suggested pre-committing to splitting Phase 2 into 2a (text-only doc sweep) and 2b (screenshot tooling). The reviewer themselves said "not load-bearing — recommendation, not requirement." The spec § 3 opener acknowledges the split is an implementer call at PR-prep time rather than a pre-commitment. Pre-committing the split would constrain the Phase 2 plan-writer cycle without strong signal that it's needed; defer to the Phase 2 implementer to decide based on actual review load.
- **Revisit when:** Phase 2 plan-writing reveals the PR would exceed typical review load. The Phase 2 writing-plans output is the natural place to make the split decision.
- **Original finding evidence:** "The Phase 2 PR carries: README rewrite, CONTRIBUTING.md extraction, 9-surface status sweep, a new Playwright capture script, fresh PNG assets, plus § 5.1+§5.5 S6 spec amendments..."

### [Skip] PL-09 — README "professional" framing without engaging vision's anti-marketing posture

- **Source:** `ce-doc-review` product-lens persona on 2026-05-28 (spec pass).
- **Severity:** P3 — advisory observation.
- **Date:** 2026-05-28
- **Reason:** Reviewer suggested the spec should explicitly weigh whether the README should import the vision doc's self-skeptical wedge framing. The substance of this finding was folded into spec § 3.1's Tone paragraph ("The vision doc's self-skeptical posture about the wedge ... lands in the README as honest framing — a distinctive, possibly stronger posture than confident feature bullets") rather than carried as a structural section. A separate sub-decision section would be overkill for a recommendation already absorbed into the tone guidance.
- **Revisit when:** n/a — folded into spec text.
- **Original finding evidence:** "The roadmap's tone constraint ('no marketing copy', 'verb-first', 'plain prose') is correct in spirit but doesn't go further. The vision doc is unusually anti-marketing..."

---

## Plan review — 2-persona ce-doc-review pass (2026-05-28)

All 4 findings from the plan ce-doc-review pass were **applied**, not skipped. The 4 applied items:

1. **FEAS-P-001**: Bash-tool note on heredoc commit blocks (pwsh equivalence).
2. **FEAS-P-002**: `gh auth status` sub-step before draft-Release download in Task 4 Step 3.
3. **FEAS-P-003**: `--cleanup-tag` no-op caveat in Task 4 Step 6.
4. **COH-P-001**: Worktree-cleanup source ambiguity — restructured to `git -C D:/src/PRism` from main checkout, v1-roadmap worktree removal moved to Task 1 Step 7.

No deferrals from the plan pass — this section exists only to confirm completeness of the sidecar for the plan-review side.
