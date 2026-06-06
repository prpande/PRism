# #214 — ce-doc-review dispositions & deferrals

One `ce-doc-review` pass (T2), 4 reviewers: coherence, feasibility, design-lens,
adversarial. Verified each surviving finding against source before applying
(`receiving-code-review` rigor). For the PR `## Proof` section.

## Dispositions

| # | Reviewer | Finding | Conf | Disposition | Note |
|---|----------|---------|------|-------------|------|
| F1 | feasibility | e2e injection seam doesn't exist — `GetDiffAsync` hardcoded to single file `src/Calc.cs` | 100 | **Applied** | Verified (FakePrReader.cs:69-104). Spec now adds a minimal test-only backend seam. |
| F2 | feasibility | Files list omits the backend change | 75 | **Applied** | Backend test-hook files added to Files list. |
| F3 | feasibility | var-write / wheel / RO target element unspecified | 75 | **Applied** | Scoped to dedicated hook; spec names `.fileTreeScroll` as the target. |
| F4 | feasibility | spacer math correct (FYI) | 50 | **Applied** | Kept as verified note + a one-line code comment at impl. |
| D1 | design | `scroll-padding-bottom` needed so last row clears the sticky bar | 100 | **Applied** | Added `scroll-padding-bottom:14px` on `.filesTabTree`. |
| D2 | design | wheel/trackpad target unspecified | 100 | **Applied** | Same as F3. |
| D3 | design | empty/skeleton var cleanup | 75 | **Applied** | Var on `.fileTreeScroll`, which unmounts on those paths → clean; hook null-guards. |
| D4 | design | bar dark/light + Windows scrollbar-width | 75 | **Partial** | Mirror exact `.diffHScroll` props. Windows 17px>14px thumb is **pre-existing** (diff has it) → out of scope, noted. |
| D5 | design | keyboard horizontal-pan / bar tabIndex / WCAG 2.1.1 | 75 | **Deferred** | Match diff precedent (bar `aria-hidden`, non-tabbable); names reachable via row `title`. Dedicated keyboard-pan = follow-up (cf. #200). Rationale in spec. |
| D6 | design | hook signature unspecified | 75 | **Superseded** | Dedicated hook → no shared-signature change. |
| A1 | adversarial | overlap contradicts criterion 2 "match the diff" | 75 | **Applied (reframe)** | Criterion 2 relaxed to "pinning matches; overlay is an accepted, gate-surfaced divergence." A is issue-authorized; escalate to B only if rejected at visual gate. |
| A2 | adversarial | "A-prime" — reserve strip via `padding-bottom` (keeps #187, no overlap) | 50 | **Evaluated, rejected** | Padding only clears the *true end*, not mid-scroll overlap. No free lunch in A; true no-overlap needs B. Documented. |
| A3 | adversarial | full-pane bar's thumb proportion is dishonest | 75 | **Applied** | Bar constrained to `.fileTreeScroll` width via a 2-cell footer row → honest thumb, true diff parity. |
| A4 | adversarial | drop the hook generalization (adds diff-regression risk for 1 consumer) | 75 | **Applied** | **Reverses the first-draft recommendation.** Dedicated `useTreeHScroll`; diff path untouched. |
| A5 | adversarial | sticky short-tree edge case untraced | 50 | **Applied** | Added e2e/manual case: horizontally-overflowing + vertically-short tree. |
| A6 | adversarial | #187-drift attribution unverified | 50 | **Applied** | Verified: #187 sticky drift was horizontal checkbox-pinning over native overflow (187 doc:220-221) — not my mechanism. Cited. |
| — | coherence | no findings | — | — | Clean pass. |

## Deferrals (tracked, not dropped)

- **Keyboard horizontal-pan of the tree viewport** (D5). The synthetic bar is a
  pointer affordance, matching the diff. A keyboard-only user cannot pan the tree
  horizontally; full names are still reachable via row `title` + the row reading the
  full path to assistive tech. A first-class keyboard pan belongs with the broader
  tree-keyboard work (cf. #200). File/fold there if it surfaces as a real gap.
- **Windows always-visible scrollbar thumb (~17px) overflowing the 14px bar** (D4).
  Pre-existing on the diff bar; not introduced here. Revisit if a cross-platform
  scrollbar-styling pass happens.
