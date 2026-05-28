---
source-doc: docs/specs/2026-05-28-v1-completion-roadmap-design.md
plan-doc: docs/plans/2026-05-28-v1-completion-roadmap.md
created: 2026-05-28
last-updated: 2026-05-28
status: partially-resolved
revisions:
  - 2026-05-28: created during PR #84 review pass to record the 6 ce-doc-review findings that were skipped (not applied) during the spec + plan review cycles. All 6 are non-applicable per the false-positive / pedantic-folded categories in the ce-doc-review false-positive catalog; recorded for institutional memory and to satisfy the documentation-maintenance policy that requires a deferrals sidecar when ce-doc-review surfaces rejected alternatives.
  - 2026-05-28 (amendment PR): added the `[Defer]` "Phase 1 — scope shift to native-app-shell" entry recording the scope-change decision that defers Phase 1 (single-instance enforcement) out of v1. Status flips to `partially-resolved` because the new entry is `[Defer]` (open until the native-app-shell workstream lands), while the original six entries remain `[Skip]` (closed).
---

# Deferrals — v1 completion roadmap

This sidecar carries two kinds of entries:

1. **Six `[Skip]` entries** — `ce-doc-review` findings that surfaced during the original spec (5-persona) and plan (2-persona) review passes and were **not** applied. All non-applicable per the false-positive / pedantic-folded categories. Status: closed.
2. **One `[Defer]` entry** — the 2026-05-28 amendment PR's scope-change decision that defers Phase 1 (single-instance enforcement) out of v1 scope. Status: open until the native-app-shell workstream lands and Phase 1 brainstorm resumes.

The original spec + plan review pipeline applied ~25 findings on the spec and 4 on the plan; that work landed in the spec/plan files themselves. The amendment PR applied additional changes across 4 files (spec, meta-plan, docs/roadmap.md, this sidecar) — those changes landed in the files themselves, not here.

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

---

## Amendment PR — scope-change deferral (2026-05-28)

### [Defer] Phase 1 — scope shift to native-app-shell architecture

- **Source:** Pratyush + Claude collaborative brainstorm exit, 2026-05-28. Surfaced when the Phase 1 single-instance brainstorm opened against the original spec § 2.2 seed prompt, hit the foundational question "what does 'focus the existing window' mean for a backend-HTTP-server + browser-tab architecture?", and the user disclosed that the application architecture is shifting to a native shell at or before v0.1.0.
- **Severity:** P0 — scope change to v1 ship line.
- **Date:** 2026-05-28.
- **Decision:** Drop Phase 1 (single-instance enforcement) from v1 scope. Apply the § 6.1 fallback action (README known-issue paragraph) with wording option (iii) per the amendment-pass discussion — drop the "lands in vX.Y" clause entirely. v1 ships with the avoidance instruction only; no enforcement code.
- **Why deferred rather than skipped.** The work is genuinely valuable (two-PRism-windows is the largest credible v1 data-loss path per spec § 1.6) but the design space depends on the shell-framework choice (WebView2 / Tauri / Electron / MAUI Blazor Hybrid). Each shell flips the IPC channel, mutex placement, focus API, and second-launch UX surface. Designing now produces work that gets re-done at shell-migration time; designing against the future shell requires the framework decision first.
- **Why not § 6.1's original trigger conditions.** § 6.1 originally specified quantitative triggers (>8 tasks / >3 PRs / >10 calendar days from brainstorm start). Neither fired — the brainstorm was cut short by the scope disclosure before plan-writing began. The fallback ACTION (drop + README paragraph) is what's wanted; the TRIGGER replacement is "scope shift surfaced at brainstorm-open time."
- **Wording chosen for the README known-issue bullet.** Option (iii) from the amendment-pass options:
  > *"Avoid launching PRism more than once on the same machine — concurrent instances will overwrite each other's draft state."*
  No "lands in vX.Y" clause. The README's job is to set user expectations about behavior, not to publish internal roadmap timing. (Options (i) "lands in a future release" and (ii) "lands after the application-shell architecture ships" were both rejected: (i) is vague filler that ages poorly; (ii) reveals an internal architectural shift that hasn't been publicly committed and would confuse a v0.1.0 reviewer who doesn't know what "application shell" means.)
- **Revisit when:** The native-app-shell workstream lands and picks a framework. Phase 1 single-instance brainstorm resumes against that framework's primitives.
- **Files amended in this PR:**
  - `docs/specs/2026-05-28-v1-completion-roadmap-design.md` — added Amendments section at the top; § 1.2 Phase 1 row marked Deferred; § 1.3 added single-instance deferral entry; § 1.5 polish-before-validate rationale updated to disclose only 2 of 3 prongs remain post-deferral; § 1.6 two-windows row updated to reference docs-only mitigation; § 2 collapsed from full Phase 1 spec to deferral pointer; § 3.1 README table added a Known issues row + § 3.3 Features row updated + § 3.3 docs/roadmap.md row rewritten to reflect "Phase 1 already Deferred from amendment, sweep flips Phase 2" + § 3.3 docs/specs/README.md row dropped the never-existing-Phase-1-spec promotion; § 3.5 acceptance criteria added Known-issues bullet line + Phase 1 deferred reference; § 4.1 pre-flight gate removed Phase 1 merge dependency; § 4.3 verification dropped Phase-1-shipped vs fell-back conditional; § 4.5 reconciliation bug list dropped "single-instance misbehaving on real Windows"; § 5 exit criteria dropped OR branch; § 6.1 repurposed from "trigger and fallback risk" to "Phase 1 deferred — current status"; § 7 Phase 1 spec line marked deferred.
  - `docs/plans/2026-05-28-v1-completion-roadmap.md` — header Goal/Architecture/Tech Stack/Decomposition note updated to reflect two-phase v1; Task 2 replaced with a Deferred stub explaining the deferral and the Task 3 wait-gate change; Task 3 writing-plans seed prompt updated to include the Known issues bullet absorption and Phase 1 row already-deferred state; Task 4 verification checklist dropped the Phase-1-shipped vs fell-back conditional; Task 5 Step 7 worktree-cleanup block dropped the never-created `PRism-single-instance` removal; "Out of scope for this plan" first bullet rewritten to "Phase 1 implementation details — deferred per amendment" (originally referenced defunct Task 2 + defunct § 2.2).
  - `docs/roadmap.md` — v1 completion section Phase 1 row flipped from Pending to Deferred; Architectural-readiness Phase 1 row reverted from "v1 (Phase 1)" gate back to "Before P0+" with the deferral chain documented.
  - This sidecar (`docs/specs/2026-05-28-v1-completion-roadmap-deferrals.md`) — frontmatter status flipped to `partially-resolved`, revision history appended, intro paragraph rewritten to acknowledge both categories of entry, this `[Defer]` entry added.
- **Original finding evidence:** N/A — not a ce-doc-review finding. The trigger was a user disclosure during the brainstorm-open exchange: *"jfyi this is going to be an app on the system rather than a browser tab in the future"* (followed by "at/before v0.1.0" in response to a timing-clarification question). The brainstorm exited cleanly without producing a spec or invoking writing-plans for single-instance.
