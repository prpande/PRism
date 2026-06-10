# PR-detail header action area — design

**Issue:** #291 (`enhancement`, `design`, `needs-design`, `area:pr-detail`)
**Tier / Risk:** T3 / gated B1 (UI-visual). B2-adjacent — see §7.
**Date:** 2026-06-10
**Mockups:** `.superpowers/brainstorm/39488-1781072075/content/` (visual-companion session)

## 1. Problem & goal

The PR-detail header action area (`PrHeader.tsx` → `.prActions`) has accumulated controls that compete for horizontal space with the PR title/meta. Worst case (open PR, all conditional surfaces present) the row holds:

`[SubmitInProgressBadge] [VerdictPicker — 3 segments] [DiscardAllDraftsButton] [pending-review pill "Pending review on GitHub · Discard"] [Submit review] [Ask AI] [Open in GitHub]`

Goal: collapse this into a cohesive, consistently-sized cluster with a clear hierarchy — primary review action prominent, utility actions demoted, conditional surfaces folded in — without filling the bar with widgets. **No change to submit/verdict/recovery behavior; this is a presentation reorganization.**

## 2. Current state (what we're replacing)

| Control | Source | Role |
|---|---|---|
| `VerdictPicker` | header + `SubmitDialog` | 3-segment Approve / Request changes / Comment; binds `session.draftVerdict` |
| `SubmitButton` | header | primary; six disabled reasons via `submitDisabledReason()` |
| `SubmitInProgressBadge` | header | recovery; shown when `pendingReviewId != null` |
| pending-review pill | header (`PrHeader.tsx:491`) | "Pending review on GitHub · Discard"; opens `DiscardPendingReviewConfirmationModal` |
| `DiscardAllDraftsButton` | header | closed/merged only; opens `DiscardAllConfirmationModal` |
| `AskAiButton` | header | secondary; gated `useAiGate('composerAssist')`; toggles `AskAiDrawer` |
| `OpenInGitHubButton` | header | secondary; `GitHubMark` + "Open in GitHub" text |

`VerdictPicker` is duplicated in `SubmitDialog`; the dialog keeps its copy. The header copy is what we remove.

## 3. Design overview — three moves

1. **Collapse the primary cluster** into one stateful **Review split-button**: `VerdictPicker` + `SubmitButton` + pending pill + `SubmitInProgressBadge` + `DiscardAllDraftsButton` → a single control whose **fill color = the drafted verdict**, **trailing `*` = pending on GitHub**, and **caret menu** carries verdict selection + resume/discard.
2. **Demote Ask AI out of the row** to an **icon-only accent pull-tab** on the right margin — the handle of the existing right-anchored `AskAiDrawer`. Icon at rest, label on hover.
3. **Demote Open in GitHub** to an **icon-only** button (GitHub mark, tooltip).

After: the row is `[…title/meta…] [Open-in-GitHub icon] [Review split-button]`, plus the right-margin Ask-AI tab. The collapse chevron in the sub-tab row is unchanged.

## 4. Primary cluster — the Review split-button

A `.btn`-family control (identical metrics to today's `.btn-primary`: 30px tall, 13px/500 Geist, 6px radius, 8px gap). Two hit-targets: the **main area** (primary action) and a **trailing chevron** (opens the menu). Reuses the exact verdict fills already defined for `.verdict-picker__segment--selected[data-verdict=…]`.

### 4.1 States, fill, label

| State | Condition | Fill (token) | Label | Main click | Chevron menu |
|---|---|---|---|---|---|
| Default | open PR, `draftVerdict === null`, not pending | `--accent` | `Submit review` | open `SubmitDialog` if enabled, else disabled w/ tooltip | set verdict / submit |
| Verdict drafted | `draftVerdict` set, not pending | verdict color (`--success`/`--warning`/`--info`) | verdict word (`Approve`/`Request changes`/`Comment`) | open `SubmitDialog` | change/clear verdict / submit |
| Pending (verdict known) | `pendingReviewId != null`, `draftVerdict` set | verdict color | `<verdict>*` | open `SubmitDialog` (resume path) | resume / change verdict / **discard pending** |
| Pending (no verdict) | `pendingReviewId != null`, `draftVerdict === null` | `--accent` | `Resume review*` | open `SubmitDialog` (resume path) | resume / set verdict / **discard pending** |
| Closed / merged | `isClosedOrMerged` | `--surface-1` (`.btn-secondary`) | `Drafts` | (no submit; primary opens menu) | **discard all drafts** |

On-fill text color matches today's rules: `--accent-text` (≈near-black in dark) for accent/success/info/secondary; hardcoded `oklch(0.18 0 0)` dark ink for `--warning` (request-changes), per the existing `.verdict-picker__segment--selected[data-verdict='request-changes']` rule.

### 4.2 The asterisk (pending marker)

A pending review on GitHub is **un-finalized** work — the editor "unsaved" convention. The button carries a trailing `*` on the label (weight 600, tucked against the word) **only** while `pendingReviewId != null`. Color/shape are otherwise unchanged from the non-pending state, so the asterisk is the sole delta between "drafted locally" and "pending on GitHub." It clears when the review is submitted or the pending review is discarded.

### 4.3 Fixed min-width (no reflow)

The control's right edge is pinned to the header margin, so a width change on verdict switch would shift the adjacent icon and the title's truncation point. The button takes a **fixed `min-width` sized to the widest label** ("Request changes"); shorter labels center within it. Verdict changes recolor and relabel **without** changing width. (Chosen over accept-variable-width and over a constant "Submit review" label — we keep the verdict word.)

### 4.4 The caret menu

A surface-1 dropdown (border-2, radius-3, shadow-3) anchored under the chevron. Contents by state:

- **Normal / verdict:** section "Verdict" → Approve / Request changes / Comment (each a colored swatch; current selection checked; re-selecting the checked verdict **clears** it, preserving today's clear-via-`{draftVerdict: null}` semantics) → divider → "Submit review…".
- **Pending:** section "Pending review on GitHub" → "Resume & submit…" → "Change verdict ▸" (optional submenu or inline) → divider → **red** "Discard pending review" (→ existing `DiscardPendingReviewConfirmationModal`).
- **Closed / merged:** "Discard all drafts" (→ existing `DiscardAllConfirmationModal`), shown only when drafts exist.

### 4.5 Interaction flow & `needs-reconfirm` / disabled parity

- The **chevron menu is always operable**, even when the main submit action is disabled — so a user with no verdict can still open the menu to pick one (avoids a dead control for disabled-reason (a)).
- The **main area** preserves `submitDisabledReason()` exactly: same six reasons, same `title` tooltip, same `disabled`/`aria-disabled`. The dialog (`SubmitDialog`) and its `VerdictPicker` are **unchanged**.
- **`draftVerdictStatus === 'needs-reconfirm'`** (today shown as the picker's "Needs reconfirm" chip): surfaced on the new control — the menu's verdict section shows a "Verdict needs re-confirmation" note, re-selecting the verdict re-confirms it (re-fires `patchVerdict`, same as today), and the main action stays disabled with the existing reason-(c) tooltip until re-confirmed. Parity requirement: no regression in how needs-reconfirm is reached or cleared.

### 4.6 Open question (for spec review)

When a verdict is **already drafted**, should the **main click** open the `SubmitDialog` directly (true split-button; chevron only for changing verdict) — or always route through the menu first ("click → menu → Submit review… → dialog", matching the literal phrasing in the issue thread)? The table above assumes **direct-to-dialog when a verdict exists** (fewer clicks, GitHub-like). Flagging for the human review pass.

## 5. Ask AI pull-tab

### 5.1 Placement & behavior

`AskAiDrawer` is already `position: fixed; right: 0; width: 400px; transform: translateX(100%)→0` (z-index 50). The pull-tab is its **handle**: a small `position: fixed` tab on the right edge that calls the existing `useAskAiDrawer().toggle()`. No new drawer, no new state — only a new trigger. The header `AskAiButton` is removed.

### 5.2 Icon-only + hover label + a11y

- At rest: an **accent-colored AI icon only** (reuse the app's existing AI glyph if one ships; otherwise pick one in implementation), on a surface-1 tab with a left-rounded edge.
- On hover/focus: a "Ask AI" label slides out to the left (`max-width`/opacity transition).
- `aria-label="Ask AI"` + `title="Ask AI"` back the hover label for keyboard and screen-reader users; the tab is a real `<button>`, focusable, toggles on Enter/Space.

### 5.3 Anti-collision with the Files-tab toolbar (hard constraint)

The Files-tab toolbar (`.filesTabToolbar`) is a horizontal band directly under the sub-tab row holding `IterationTabStrip` / `CommitMultiSelectPicker`, `DiffViewToggle`, and `DiffSettingsMenu` (the gear) — it is `flex-wrap: wrap`, so it can grow to two rows on narrow widths. The fixed pull-tab **must not overlap these controls at default/representative widths**. Approach: anchor the tab **vertically centered in the content viewport** (well below the toolbar band) rather than near the top, and verify in the running app at default width that it clears the rightmost toolbar control in both the one-row and wrapped-two-row toolbar states. This is an acceptance criterion (§11).

### 5.4 Visibility gating

The tab renders only **on PR-detail** (Ask AI is PR-scoped; threads keyed by `prRefKey`) and only when `useAiGate('composerAssist')` is true — same gate as today's `AskAiButton`. It must not appear on the inbox or other routes.

## 6. Open in GitHub → icon-only

`OpenInGitHubButton` becomes icon-only: the `GitHubMark` alone in a `.btn-icon` (30×30, surface-1, border-2), `aria-label`/`title="Open in GitHub"`. All existing behavior preserved — absent `href` → render nothing; desktop `window.prism.openExternal` interception gated on the method's presence; browser `target="_blank"`.

## 7. Behavior preservation (B2-adjacency note)

This redesign reorganizes how the **reviewer-atomic submit pipeline** is *entered and displayed*. It must **not** alter:

- the `addPullRequestReview → thread/reply → submitPullRequestReview` GraphQL pipeline or any of its IDs (`pendingReviewId`, `threadId`, `replyCommentId`, `prism:client-id`);
- the `PUT /draft` verdict patch shape (incl. `{draftVerdict: null}` clear);
- the resume/discard semantics (`DiscardPendingReviewConfirmationModal`, `DiscardAllConfirmationModal`, the `onResume` path into `SubmitDialog`);
- `submitDisabledReason()` and the dialog.

All new code is presentation + wiring to the **existing** handlers (`patchVerdict`, `onSubmit`, `onResume`, `onDiscardAllDrafts`, the pending-discard flow). Re-checked at the pre-PR gate.

## 8. Component boundaries

**New:**
- `ReviewActionButton` (working name) — the stateful split-button + its caret menu. Inputs: `session`, `prState`/`isClosedOrMerged`, `headShaDrift`, `validatorResults`, `dialogOpen`, and the existing callbacks (`patchVerdict`, `onOpenSubmit`, `onResume`, `onDiscardPending`, `onDiscardAllDrafts`). Pure presentation; derives state from props. Testable in isolation (state→fill/label/menu mapping).
- `AskAiPullTab` — fixed right-edge tab; consumes `useAskAiDrawer` + `useAiGate`; rendered once at the PR-detail level (not per-header-instance — see below).

**Changed:**
- `PrHeader.tsx` `.prActions` — replace the seven-control block with `[OpenInGitHubButton icon] [ReviewActionButton]`.
- `OpenInGitHubButton.tsx` — icon-only variant.
- Mount point for `AskAiPullTab`: `PrDetailView` (so a single tab exists per PR-detail surface, not duplicated by keep-alive tab hosts). Confirm against the keep-alive tab architecture during planning.

**Removed from the header render path:** header `VerdictPicker`, `SubmitButton`, `SubmitInProgressBadge`, pending-review pill, `DiscardAllDraftsButton`, `AskAiButton`. (`VerdictPicker`, `SubmitButton`’s `submitDisabledReason`, and the modals remain — reused by the dialog / new control.)

## 9. Accessibility

- Split-button: main + chevron are distinct buttons with distinct `aria-label`s ("Submit review" / "Review actions"); menu is a `role="menu"` with `menuitem`s; arrow-key navigation; Esc closes; focus returns to the chevron. Disabled main action uses `aria-disabled` + `title` (today's pattern).
- The verdict color is **not** the only signal — the verdict word (label) and the menu's checked item carry it for color-blind users. The `*` is a textual marker, not color.
- Pull-tab: focusable `<button>`, `aria-label`, keyboard-toggles the drawer; hover label is decorative reinforcement.

## 10. Testing strategy

- **Unit (vitest):** `ReviewActionButton` state→(fill class, label text, `*` presence, menu contents) for every row of the §4.1 table, incl. needs-reconfirm and each disabled reason; clear-verdict via re-select; closed/merged → Drafts/discard. `AskAiPullTab` gating (AI on/off, route) and toggle wiring. `OpenInGitHubButton` icon-only behavior parity.
- **Interaction:** menu keyboard nav, Esc, focus return; main-click opens dialog vs disabled tooltip.
- **e2e / visual (Playwright):** before/after of the header cluster in light + dark; the pull-tab resting/hover; **the anti-collision check** — pull-tab vs Files-tab toolbar at default width (one-row and wrapped). Regenerate affected baselines (header change ripples into PR-detail full-page baselines; Linux baselines from CI artifact per house process).
- **Behavior preservation:** existing submit/verdict/resume/discard tests must pass unchanged.

## 11. Acceptance criteria

- [ ] Action row collapses to one primary control + at most one icon-only secondary (Open in GitHub); no inline 3-segment picker, no verbose pending pill, no separate resume badge / discard button in the row.
- [ ] Review split-button: default = accent; drafted verdict recolors to that verdict's existing semantic color at a **fixed min-width** (no reflow on change); pending adds trailing `*`; caret menu carries verdict selection + resume/discard; closed/merged → secondary "Drafts" with discard-all.
- [ ] All six `submitDisabledReason()` tooltips and the `needs-reconfirm` flow preserved and reachable from the new control.
- [ ] Ask AI demoted to an icon-only accent pull-tab (existing drawer's handle; label on hover; `aria-label`), shown only on PR-detail when AI-gated.
- [ ] Pull-tab does **not** intersect the Files-tab toolbar controls at default widths (verified in the running app, one-row and wrapped toolbar).
- [ ] Open in GitHub is icon-only with tooltip; all link/desktop behavior preserved.
- [ ] No change to the reviewer-atomic submit pipeline, draft-patch shape, or recovery semantics.
- [ ] Cohesive, consistently-sized cluster; graceful at narrower widths; verified light + dark with before/after screenshots.

## 12. Out of scope / deferrals

- No change to `SubmitDialog` internals or its `VerdictPicker`.
- No change to the submit GraphQL pipeline, draft autosave, or recovery modals' internals.
- AI icon selection: reuse an existing glyph if available, else pick during implementation (not a design blocker).
- Header condense (#128) and desktop min-size (#284) interactions are respected, not re-opened.

## 13. Open questions (for the human review pass)

1. **Main-click behavior when a verdict exists** (§4.6): direct-to-dialog (assumed) vs always-through-menu.
2. **Pull-tab vertical anchor**: viewport-centered (assumed) vs a fixed offset — finalize against the real toolbar height once measured in the app.
3. **"Change verdict" while pending**: inline submenu vs a flat list in the pending menu — minor, can settle in planning.
