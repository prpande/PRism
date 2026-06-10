# PR-detail header action area — design

**Issue:** #291 (`enhancement`, `design`, `needs-design`, `area:pr-detail`)
**Tier / Risk:** T3 / gated B1 (UI-visual). B2-adjacent — see §7.
**Date:** 2026-06-10
**Mockups:** `.superpowers/brainstorm/39488-1781072075/content/` (visual-companion session)
**Review:** incorporates ce-doc-review round 1 (6 personas) — dispositions in §14.

## 1. Problem & goal

The PR-detail header action area (`PrHeader.tsx` → `.prActions`) has accumulated controls that compete for horizontal space with the PR title/meta. Worst case (open PR, all conditional surfaces present) the row holds:

`[SubmitInProgressBadge] [VerdictPicker — 3 segments] [DiscardAllDraftsButton] [pending-review pill "Pending review on GitHub · Discard"] [Submit review] [Ask AI] [Open in GitHub]`

Goal: collapse this into a cohesive, consistently-sized cluster with a clear hierarchy — primary review action prominent, utility actions demoted, conditional surfaces folded in — without filling the bar with widgets. **No change to submit/verdict/recovery behavior; this is a presentation reorganization** (preservation invariants in §7).

## 2. Current state (what we're replacing)

| Control | Source | Role |
|---|---|---|
| `VerdictPicker` | header + `SubmitDialog` | 3-segment Approve / Request changes / Comment; binds `session.draftVerdict` |
| `SubmitButton` | header | primary; six disabled reasons via `submitDisabledReason()` |
| `SubmitInProgressBadge` | header | recovery; shown when `pendingReviewId != null` |
| pending-review pill | header (`PrHeader.tsx:491`) | "Pending review on GitHub · Discard"; gated `!dialogOpen`; opens `DiscardPendingReviewConfirmationModal` |
| `DiscardAllDraftsButton` | header | closed/merged only; opens `DiscardAllConfirmationModal` |
| `AskAiButton` | header | secondary; gated `useAiGate('composerAssist')`; toggles `AskAiDrawer` |
| `OpenInGitHubButton` | header | secondary; `GitHubMark` + "Open in GitHub" text |

`VerdictPicker` is duplicated in `SubmitDialog`; **the dialog keeps its copy — only the header instance is removed.** The `pending-review pill`'s `!dialogOpen` gate is a deliberate mutual-exclusion invariant (§7), not incidental.

## 3. Design overview — three moves

1. **Collapse the primary cluster** into one stateful **Review split-button** (`ReviewActionButton`): `VerdictPicker` + `SubmitButton` + pending pill + `SubmitInProgressBadge` + `DiscardAllDraftsButton` → a single control whose **fill = the drafted verdict's color**, **trailing `*` = pending on GitHub**, and **caret menu** carries verdict selection + resume/discard.
2. **Demote Ask AI out of the row** to an **icon-only accent pull-tab** on the right margin — the handle of the existing right-anchored `AskAiDrawer`. Icon at rest, label on hover.
3. **Demote Open in GitHub** to an **icon-only** button (GitHub mark, tooltip).

After: the row is `[…title/meta…] [Open-in-GitHub icon] [Review split-button]`, plus the right-margin Ask-AI tab. The collapse chevron in the sub-tab row is unchanged.

**Header layout contract (narrow widths).** The title block is `flex: 1 1 0; min-width: 0` (truncates first); the control cluster is `flex: 0 0 auto`. As width shrinks, the title truncates to its floor; below that floor the **Open-in-GitHub icon drops first** (its action lives in the row's overflow / is reachable via the menu's none — see §6), then the cluster may wrap to a second line. The split-button never shrinks below its fixed min-width (§4.3). Exact floor confirmed in implementation against the running app.

## 4. Primary cluster — the Review split-button

A `.btn`-family control (identical metrics to today's `.btn-primary`: 30px tall, 13px/500 Geist, 6px radius, 8px gap). Two hit-targets: the **main area** (primary action) and a **trailing chevron** (opens the menu). Reuses the exact verdict fills already defined for `.verdict-picker__segment--selected[data-verdict=…]`.

### 4.1 State as orthogonal derivations (not a flat table)

`needs-reconfirm`, `pending`, `in-flight (frozen)`, and the verdict are **independent axes** that can co-occur (e.g. a resumed review whose verdict went stale → pending **and** needs-reconfirm). Deriving each visual property as a function of the relevant axis avoids the undefined composite states a single-row-per-state table produces.

| Property | Derivation |
|---|---|
| **Fill** | `isClosedOrMerged` → `--surface-1` (`.btn-secondary`). Else verdict color: approve→`--success`, request-changes→`--warning`, comment→`--info`; `draftVerdict === null` → `--accent`. On-fill text: `--accent-text` for all fills **except** request-changes/`--warning`, which uses hardcoded `oklch(0.18 0 0)` (the existing rule). |
| **Label** | `isClosedOrMerged` → `Drafts`. Else: the verdict word (`Approve`/`Request changes`/`Comment`), or `Submit review` (null verdict, not pending), or `Resume review` (null verdict, pending). |
| **Suffix `*`** | present iff `pendingReviewId != null` (the trailing dirty-marker, §4.2). Included in the min-width measurement (§4.3). |
| **needs-reconfirm face signal** | iff `draftVerdictStatus === 'needs-reconfirm'`: a face signal **on the button itself** (amber `⚠` glyph prepended, or an amber ring) — not only the menu note. Parity with today's inline "Needs reconfirm" chip; without it a green "Approve" button looks submit-ready when it isn't. |
| **Main action (click)** | `pendingReviewId != null` → `onResume` (resume path, wired to `submit.lastResume` / `ImportedDraftsBanner`). Else → `onOpenSubmit` (opens `SubmitDialog`). `isClosedOrMerged` → no main submit action (click opens the menu). |
| **Main disabled** | `submitDisabledReason() !== null` (covers needs-reconfirm (c), stale, validators, head-SHA drift, empty, comment-empty) **OR** `inSubmitFlow` (frozen during pipeline) **OR** `isClosedOrMerged`. Tooltip = the reason string (today's behavior). Disabled-reason (a) tooltip gains directional copy: *"Pick a verdict using the ▾ menu, or add a comment."* |
| **Menu contents** | see §4.4 |
| **Menu availability** | the chevron always opens the menu **except** while `inSubmitFlow` (frozen) — then both the main area **and** the menu are disabled, mirroring today's `VerdictPicker disabled` during in-flight. |

**Precedence** when axes combine: `isClosedOrMerged` > `pending` > verdict-set > default for label/fill; `inSubmitFlow` (frozen) overrides interactivity on both targets regardless of the others. Representative derived examples (each row is a *consequence* of the rules, not a separate hand-authored state):

| Scenario | Fill | Label | Main click | Notes |
|---|---|---|---|---|
| Open, no verdict | accent | `Submit review` | disabled (reason a) w/ directional tooltip; menu still opens | |
| Open, Approve drafted | success | `Approve` | open dialog | |
| Open, Request changes, needs-reconfirm | warning | `⚠ Request changes` | disabled (reason c) | face signal + menu note |
| Pending, Comment drafted | info | `Comment*` | resume | `*` = pending |
| Pending, no verdict | accent | `Resume review*` | resume | fallback |
| Pending **and** needs-reconfirm | verdict color | `⚠ <verdict>*` | **resume (enabled)** | compound — resume is never gated (matches today's `SubmitInProgressBadge`); `⚠` shown; explicitly tested (§10) |
| In-flight submit (frozen) | (current fill) | (current label) | disabled; **menu disabled too** | |
| Closed / merged | secondary | `Drafts` | opens menu (no submit) | |

### 4.2 The asterisk (pending marker)

A pending review on GitHub is **un-finalized** work — the editor "unsaved" convention. The button carries a trailing `*` (weight 600, tucked against the word) only while `pendingReviewId != null`. Because "pending review on GitHub" is a non-obvious, loss-risky state, the `*` is **not the only affordance**: the button gets a `title`/tooltip *"Pending review on GitHub — not yet submitted"*, and the caret menu's "Pending review on GitHub" section header is visible on open. The `*` clears when the review is submitted or the pending review is discarded.

### 4.3 Fixed min-width (no reflow)

The control's right edge is pinned to the header margin, so a width change on verdict switch would shift the adjacent icon and the title's truncation point. The button takes a **fixed `min-width` sized to the widest rendered label including the `*` suffix** — i.e. `Request changes*` (verb + asterisk), measured **per density mode** (`[data-density="compact"]` redefines `--s-3` and friends, so the widest pixel width is mode-dependent). Express the reserve in `ch`/token units that track density rather than a hardcoded px. Verdict changes recolor and relabel **without** changing width, in **both** density modes (§11). (Chosen over accept-variable-width and over a constant "Submit review" label — we keep the verdict word.)

### 4.4 The caret menu

A surface-1 dropdown (border-2, radius-3, shadow-3) anchored under the chevron, `role="menu"`. Contents by state — **flat lists only** (no nested submenu; keeps one keyboard model, §9):

- **Normal / verdict:** section "Verdict" → Approve / Request changes / Comment (each a colored swatch; current selection checked; **re-selecting the checked verdict clears it** — the sole clear path, preserving today's `{draftVerdict: null}` semantics, and *not* triggered by picking a different verdict) → divider → "Submit review…".
- **Pending:** section "Pending review on GitHub" → "Resume & submit…" → the same flat Verdict rows (change verdict while pending) → divider → **red** "Discard pending review" (→ existing `DiscardPendingReviewConfirmationModal`). **The "Discard pending review" item is suppressed while `dialogOpen` is true** — see §7 (mutual-exclusion invariant). The whole menu is disabled while `inSubmitFlow`.
- **Closed / merged:** "Discard all drafts" (→ existing `DiscardAllConfirmationModal`), shown only when drafts exist.

### 4.5 `needs-reconfirm` & disabled parity

- The **chevron menu is operable whenever the main action is disabled** (so a user with no verdict can still open it to pick one — avoids a dead control for disabled-reason (a)) — **except** while `inSubmitFlow`, when both targets are frozen.
- The **main area** preserves `submitDisabledReason()` exactly: same six reasons, same `title` tooltip, same `disabled`/`aria-disabled`. The dialog (`SubmitDialog`) and its `VerdictPicker` are **unchanged**.
- **`needs-reconfirm`** is surfaced in **two** places: the button-face signal (§4.1) **and** a menu note ("Verdict needs re-confirmation"); re-selecting the verdict re-confirms it (re-fires `patchVerdict`, as today); the main action stays disabled with reason-(c) tooltip until re-confirmed. Parity requirement: no regression in how needs-reconfirm is reached or cleared.

## 5. Ask AI pull-tab

### 5.1 Placement, mount point & open-state behavior

`AskAiDrawer` is already `position: fixed; right: 0; width: 400px; transform: translateX(100%)→0` (z-index 50), mounted **once at `App.tsx`** (beside the drawer body), with its PR ref derived from the route. The pull-tab follows the **same singleton pattern**, **not** `PrDetailView`:

- **Mount once at `App.tsx`** next to `<AskAiDrawer />`. (`PrDetailView` is the *per-tab* component — `PrTabHost` renders one per open PR — so mounting there would create N tabs, suppressed only by the inactive views' `hidden`/`display:none`. The singleton App-level mount makes "exactly one tab" structurally true, matching the drawer's own precedent.)
- **Open-state behavior (was unspecified).** When the drawer is open, a `right:0` tab would be occluded by the 400px panel. The tab **rides the drawer's leading edge**: closed → anchored at `right:0`; open → `right:400px` (the drawer's left edge), becoming the drawer's visible close affordance. It animates in sync with the drawer's `transform`. `aria-expanded` reflects `isOpen`; the open state uses a distinct active/pressed fill and the hover label reads "Close". `toggle()` drives both directions.

### 5.2 Icon-only + hover label + a11y

- At rest: an **accent-colored AI icon only** — reuse the app's existing `ai-icon` glyph (already in `AskAiDrawer.tsx`), on a surface-1 tab with a left-rounded edge. The icon must be **recognizable without the label** (the label is hover/focus-only and absent on touch).
- On hover/focus: a "Ask AI" (or "Close" when open) label slides out to the left (`max-width`/opacity transition).
- `aria-label` ("Ask AI" / "Close") + `aria-expanded` + `title` back the hover label for keyboard, screen-reader, and touch users; the tab is a real `<button>`, focusable, toggles on Enter/Space.

### 5.3 Anti-collision (hard constraint)

The fixed tab must not occlude **any** load-bearing content at its resting height, across Overview / Files / Drafts:

- the Files-tab toolbar (`.filesTabToolbar`: `IterationTabStrip`/`CommitMultiSelectPicker` + `DiffViewToggle` + `DiffSettingsMenu`; `flex-wrap: wrap`, so one **or two** rows) — the gear is the rightmost child, hard against the right edge;
- diff content (the right end of a wide diff row), the **#214 sticky horizontal scrollbar**, and an **open inline comment composer** (which can appear anywhere in the diff column).

Approach: dock the tab at a **fixed vertical band with a safe margin** (e.g. vertically centered or a fixed corner offset) chosen to clear the toolbar in both the one-row and wrapped states **and** to sit outside the diff content column's interactive zone. This is verified in the running app and is an acceptance criterion (§11).

### 5.4 Visibility gating

The tab renders only **on PR-detail** and only when AI is gated on. Because it mounts at App level (§5.1), "PR-detail only" is **not** automatic — it requires an explicit route predicate: `parsePrRefFromPathname(pathname) !== null` (the same predicate `DrawerEffects` already uses) **AND** `useAiGate('composerAssist')`. It must not appear on the inbox or other routes.

## 6. Open in GitHub → icon-only

`OpenInGitHubButton` becomes icon-only: the `GitHubMark` alone in a `.btn-icon` (30×30, surface-1, border-2), `aria-label`/`title="Open in GitHub"`. All existing behavior preserved — **absent `href` → do not render the button**; desktop `window.prism.openExternal` interception gated on the method's presence; browser `target="_blank"`.

## 7. Behavior preservation (B2-adjacency) — invariants

This redesign reorganizes how the **reviewer-atomic submit pipeline** is *entered and displayed*. It must **not** alter:

- the `addPullRequestReview → thread/reply → submitPullRequestReview` GraphQL pipeline or its IDs (`pendingReviewId`, `threadId`, `replyCommentId`, `prism:client-id`);
- the `PUT /draft` verdict patch shape (incl. `{draftVerdict: null}` clear);
- **the pending-discard mutual-exclusion invariant** — today the pending-review pill is gated `!dialogOpen` so it and the dialog footer's Discard can never both drive a discard at once. The new control **carries this forward**: the menu's "Discard pending review" item is suppressed while `dialogOpen` is true. (Without this, an "always-operable" menu would reintroduce two simultaneous discard paths — a recovery-path regression.)
- the resume path (`onResume` → `SubmitDialog` with `submit.lastResume` / `ImportedDraftsBanner`): **pending main-click maps to `onResume`, non-pending to `onOpenSubmit`** (explicit per-state callback mapping, §4.1) — so the resume snapshot wiring is not bypassed;
- `submitDisabledReason()` and the dialog.

All new code is presentation + wiring to the **existing** handlers (`patchVerdict`, `onOpenSubmit`/`setDialogOpen`, `onResume`, `onDiscardAllDrafts`, the pending-discard flow). Re-checked at the pre-PR gate; preservation tests in §10.

## 8. Component boundaries

**New:**
- `ReviewActionButton` (working name) — the stateful split-button + caret menu. Inputs: `session`, `isClosedOrMerged`/`prState`, `headShaDrift`, `validatorResults`, `dialogOpen`, `inSubmitFlow`, and the existing callbacks (`patchVerdict`, `onOpenSubmit`, `onResume`, `onDiscardPending`, `onDiscardAllDrafts`). Pure presentation; derives all visuals from props per §4.1. Testable in isolation (axis→derivation mapping).
- `AskAiPullTab` — fixed right-edge tab, **mounted once at `App.tsx`** beside `<AskAiDrawer />` (§5.1); consumes `useAskAiDrawer` (`isOpen`/`toggle`) + `useAiGate` + the `parsePrRefFromPathname` route gate.

**Changed:**
- `PrHeader.tsx` `.prActions` — replace the seven-control block with `[OpenInGitHubButton icon] [ReviewActionButton]`.
- `OpenInGitHubButton.tsx` — icon-only variant.
- `App.tsx` — mount `<AskAiPullTab />`.

**Removed from the header render path:** header `VerdictPicker` instance, `SubmitButton`, `SubmitInProgressBadge`, pending-review pill, `DiscardAllDraftsButton`, `AskAiButton`. (`VerdictPicker`, `submitDisabledReason`, and the modals **remain in the dialog / are reused by the new control** — nothing is deleted from the codebase.)

## 9. Accessibility

- Split-button: main + chevron are distinct buttons with distinct `aria-label`s ("Submit review" / "Review actions"); menu is `role="menu"` with `menuitem`s; **flat lists only** (no nested submenu — one keyboard model); arrow-key nav; Esc closes; focus returns to the chevron.
- Verdict color is **not** the only signal — the verdict word (label), the `⚠` for needs-reconfirm, the `*` for pending, and the menu's checked item all carry meaning textually for color-blind users. Asterisk and `⚠` must meet WCAG AA (4.5:1) against every fill in both themes (§11).
- Pull-tab: focusable `<button>`, `aria-label` + `aria-expanded`, keyboard-toggles the drawer; recognizable icon at rest (touch has no hover/label).

## 10. Testing strategy

- **Unit (vitest):** `ReviewActionButton` — derivation functions (fill / label / suffix / main-action / main-disabled / face-signal / menu-contents) across the axes, including the **compound `pending × needs-reconfirm`** case, the `inSubmitFlow` frozen case (main **and** menu disabled), every `submitDisabledReason` reason, clear-via-reselect, and closed/merged → Drafts. `AskAiPullTab` — gating (`useAiGate` × route predicate), `toggle` wiring, open-state (`aria-expanded`, ride-to-`right:400px`, label→"Close"). `OpenInGitHubButton` icon-only parity.
- **Preservation:** pending main-click fires `onResume` (not `onOpenSubmit`) and still produces `ImportedDraftsBanner`; **dialog-open ⇒ only one discard-pending path live** (menu item suppressed); verdict patch shape unchanged.
- **Interaction:** menu keyboard nav, Esc, focus return; main-click opens dialog vs disabled tooltip; chevron operable when main disabled, frozen when in-flight.
- **e2e / visual (Playwright):** before/after of the header cluster, light + dark; pull-tab resting / hover / **open (riding the drawer edge)**; **anti-collision** — tab vs Files-tab toolbar (one-row and wrapped), diff content, #214 sticky scrollbar, and an open composer, at default width; **no-reflow** on verdict switch in **both** density modes. Regenerate affected PR-detail full-page baselines (Linux from CI artifact, win32 local, per house process).

## 11. Acceptance criteria

- [ ] Action row collapses to one primary control + at most one icon-only secondary (Open in GitHub); no inline 3-segment picker, no verbose pending pill, no separate resume badge / discard button in the row.
- [ ] Review split-button derives fill/label/suffix/disabled per §4.1: default = accent; drafted verdict = its semantic color at **fixed min-width** (no reflow on change, **both density modes**); pending adds trailing `*` (+ tooltip); `needs-reconfirm` shows a **button-face** signal; caret menu (flat) carries verdict selection + resume/discard; closed/merged → secondary "Drafts".
- [ ] All six `submitDisabledReason()` tooltips preserved (reason (a) gains directional copy); `needs-reconfirm` reachable + clearable; menu **and** main frozen while in-flight.
- [ ] **Pending-discard mutual-exclusion preserved** — menu's "Discard pending review" suppressed while the dialog is open; resume main-click maps to `onResume` and keeps the `ImportedDraftsBanner` wiring.
- [ ] Ask AI = icon-only accent pull-tab, **mounted once at App level**, gated on `useAiGate` **and** the PR-detail route predicate; rides the drawer edge when open (`aria-expanded`, label→"Close"); recognizable icon at rest.
- [ ] Pull-tab does **not** intersect the Files-tab toolbar (one-row **and** wrapped), diff content, the #214 sticky scrollbar, or an open inline composer — verified in the running app.
- [ ] `*` and `⚠` meet WCAG AA against every verdict fill in light + dark.
- [ ] Open in GitHub icon-only with tooltip; all link/desktop behavior preserved.
- [ ] No change to the submit pipeline, draft-patch shape, or recovery semantics (preservation tests green).
- [ ] Cohesive, consistently-sized cluster; graceful at narrower widths per the §3 layout contract; verified light + dark with before/after screenshots.

## 12. Out of scope / deferrals

- No change to `SubmitDialog` internals or its `VerdictPicker`.
- No change to the submit GraphQL pipeline, draft autosave, or recovery modals' internals.
- The AI backend itself remains placeholder (`askAiUnavailableResponses`); this work only relocates the trigger. (The product-lens note that a prominent tab fronts a not-yet-functional feature is acknowledged and accepted by the owner — the tab is `useAiGate`-gated, so it appears only for users who have enabled AI.)
- Header condense (#128) and desktop min-size (#284) interactions are respected, not re-opened.

## 13. Open questions (for the human review pass)

1. **Pull-tab resting anchor** (§5.3): vertically-centered vs a fixed corner offset — finalize against the real toolbar/diff layout once measured in the app. (Both satisfy the anti-collision AC; this is a measurement, not a behavior fork.)
2. **needs-reconfirm face signal** (§4.1): `⚠` glyph vs amber ring vs amber-overrides-verdict-fill — pick the least-noisy treatment at B1.

(Previously-open "main-click when verdict exists" is now **resolved**: direct-to-dialog for non-pending, `onResume` for pending — §4.1. "Submenu vs flat" is now **resolved**: flat — §4.4.)

## 14. ce-doc-review dispositions (round 1, 6 personas)

| Finding | Persona | Disposition | Note |
|---|---|---|---|
| Mount-point backwards (PrDetailView → App singleton) | feasibility, adversarial | **Applied** | §5.1/§8 — high-confidence verified code error |
| Pull-tab occluded by open drawer / open-state unspecified | design, adversarial | **Applied** | §5.1 — rides to `right:400px`, becomes Close |
| Discard-pending `!dialogOpen` invariant broken | adversarial | **Applied** | §7/§4.4 — suppress menu item while dialog open + test |
| Menu not frozen during in-flight | design | **Applied** | §4.1/§4.5 — both targets disabled while `inSubmitFlow` |
| Compound states not orthogonalized | adversarial, design | **Applied** | §4.1 rewritten as axis derivations + compound test |
| needs-reconfirm needs button-face signal | design | **Applied** | §4.1/§4.5 |
| Asterisk/`⚠` contrast on fills | design | **Applied** | §9/§11 AA check both themes |
| min-width must include `*` + density modes | adversarial | **Applied** | §4.3/§11 |
| Anti-collision broader than toolbar | adversarial | **Applied** | §5.3 — diff content, #214 scrollbar, composer |
| Explicit resume vs submit callback mapping | adversarial | **Applied** | §4.1/§7 |
| Resolve OQ1 (main-click) + OQ3 (submenu) | scope, design, coherence | **Applied** | §4.1 direct-to-dialog; §4.4 flat list |
| Pending discoverability (tooltip; directional reason-(a)) | product, adversarial | **Applied** | §4.2/§4.1 |
| Touch/no-hover comprehensibility | design | **Applied** | §5.2 |
| Narrow-width layout contract | design | **Applied** | §3 |
| Coherence wording (VerdictPicker remains; clear-via-reselect; baseline-regen AC; label) | coherence | **Applied** | §2/§4.4/§11 |
| AI glyph already exists (`ai-icon`) | adversarial | **Applied** | §5.2 — reuse, not "if one ships" |
| **Over-scope: drop pull-tab / keep verdict picker visible** | product, scope-guardian, adversarial | **Skipped (owner decision)** | Owner reviewed the opposing case and chose to keep the full design (split-button + pull-tab). Pull-tab is `useAiGate`-gated, mitigating the placeholder-prominence concern; split-button keeps verdict word+color glanceable. |
| Closed/merged "Drafts" kept in the unified control vs standalone | scope-guardian | **Skipped** | Kept unified for one-control consistency (minor; closed/merged isn't the crowded case either way). |
