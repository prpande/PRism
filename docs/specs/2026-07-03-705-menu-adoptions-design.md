# #705 — Adopt `useDismissableMenu` in the four remaining hand-rolled menus; unify outside-click focus-return

**Issue:** [#705](https://github.com/prpande/PRism/issues/705) (follow-up from #328 PR A #702)
**Tier / risk:** T2, hands-off. The one human-gated call in the issue was made by the repo
owner at intake (2026-07-03): **unify to no-refocus on outside dismissal**.
**Branch:** `worktree-705-menu-adoptions`

## Goal

Every lightweight popup menu in the frontend dismisses through one mechanism —
`useDismissableMenu` (document-level Escape + outside pointerdown + focus return) — and all
of them behave identically on outside-click dismissal: **focus stays where the click
landed**. Escape continues to return focus to the trigger everywhere.

Scope note: the "four remaining hand-rolled menus" are Select, FilterFacet,
ReviewActionMenu (via ReviewActionButton), and the PrActionsPanel close-confirm morph.
DiffSettingsMenu — an *existing* adopter — is also modified, but only to drop the removed
option. The three other existing adopters (PrTabStrip, IterationTabStrip,
CommitMultiSelectPicker) are untouched.

Non-goals: the merge-confirm morph in `PrActionsPanel` (its Escape/focus flow is #566
machinery, untouched); any DOM/CSS restructuring (pixel-identical rendering); the
focus-return unification for *Escape* (already uniform); Escape *layering* for stacked
lightweight surfaces (the hook's never-consume contract means one Escape dismisses every
open non-consuming surface — see decision 4; changing that is an app-wide owner call, out
of scope here).

## Decision record

1. **Outside-click focus-return (the issue's open UX question):** unify to **no refocus**.
   ARIA APG menu patterns return focus on Esc, not on outside dismissal; pulling focus back
   after the user clicked elsewhere steals it from their intended target. Consequences:
   - `returnFocusOnOutsideClose` is **removed** from `useDismissableMenu` (option + plumbing).
   - `DiffSettingsMenu.test.tsx` "closes on outside click and returns focus to the gear" is
     **flipped** to assert the panel closes and the gear does *not* regain focus.
   - `FilterFacet` — discovered during recon to be a *second* refocus-on-outside-click menu
     (its `close()` unconditionally refocuses and the outside-`mousedown` handler calls it) —
     **loses that refocus** too. Its Esc-refocus and blur-tab-away behaviors are preserved.
2. **Trigger(s) inside the boundary via consumer structure, not hook API:** the hook is
   unchanged apart from the option removal. `ReviewActionButton` — whose menu has TWO
   toggle-capable triggers (the chevron always; the main button in the 'change' and 'none'
   faces, `onMainClick`'s `setMenuOpen((v) => !v)` arm) — hosts the hook itself and passes
   its `.root` wrapper div (containing main button + chevron + mounted menu) as `rootRef`,
   the same trigger-inside-rootRef shape every existing adopter uses. A pointerdown on
   either trigger is then never an "outside" dismissal, so each trigger's own `onClick`
   owns the toggle. This replaces the "small hook extension" the issue anticipated, and it
   fixes a pre-existing quirk on `main` today: clicking the main button while the drafts
   menu is open (submitted/closed PRs) closes it via the document listener and immediately
   reopens it via the toggle — the menu appears stuck open. After adoption the toggle
   closes it properly (deliberate behavior fix, pinned by a new test).
3. **`mousedown` → `pointerdown`:** three of the four consumers listen on `mousedown` today;
   the hook uses `pointerdown`. All existing tests drive dismissal via `userEvent.click`
   (which fires pointerdown), so no test churn from the event-type change.
4. **Escape `preventDefault` delta (ReviewActionMenu, PrActionsPanel close-confirm):** both
   currently `preventDefault()` the Escape that closes them; the hook deliberately does not
   (its contract: skip an Escape someone else consumed, never consume one itself). After
   adoption their Escape matches the four existing adopters. No document-level listener in
   the app keys on `defaultPrevented` for anything *other* than this hook's own skip-guard.
   One acknowledged edge comes with the unification: a keyboard-only user can arm the
   close-confirm via Enter (no pointerdown fires, so outside-dismissal never disarms it),
   open another dismissable surface, and a single Escape then closes both, with the two
   deferred `setTimeout(0)` refocuses racing (last registration wins). Accepted as
   in-contract for lightweight menus — no data is at risk and focus lands on a reasonable
   trigger either way; Escape *layering* (topmost-only dismissal) is an app-wide question
   deliberately out of scope (see Non-goals).

## Changes by file

### `frontend/src/hooks/useDismissableMenu.ts`

- Delete `returnFocusOnOutsideClose` (option, doc comment, `close(returnFocusOnOutsideClose)`
  call site → `close(false)`, effect dep). **No other hook change** (decision 2 keeps the
  boundary problem in consumer structure).
- Doc comment updated: focus returns on Esc only; outside-click leaves focus at the target.

### `frontend/src/hooks/useDismissableMenu.test.tsx`

- Remove the `returnFocusOnOutsideClose` harness prop and its test.
- Existing "outside click closes without refocus" test stays (it is now the only behavior).

### `frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.tsx` (+ test)

- Drop `returnFocusOnOutsideClose: true` and the comment sentence pinning it.
- Test flip per decision 1.

### `frontend/src/components/controls/Select.tsx` (+ test)

- Replace the outside-pointerdown effect (lines ~154–162) with
  `useDismissableMenu({ open, rootRef, returnFocusRef: triggerRef, onClose: () => close(false) })`.
- Everything else stays local: the combobox keyboard model in `onKeyDown` (its Escape
  `preventDefault`s + `stopPropagation`s, so the hook's document Escape correctly skips it —
  a Select inside a future Modal must close without closing the Modal), Tab → `close(false)`,
  `close(refocus)` and type-ahead unchanged.
- Tests: existing outside-click and Escape tests stay green unmodified (behavior preserved).

### `frontend/src/components/Inbox/filters/FilterFacet.tsx` (+ test)

- Delete the `mousedown`/`keydown` document-listener effect; adopt
  `useDismissableMenu({ open, rootRef: ref, returnFocusRef: triggerRef, onClose: () => setOpen(false) })`.
- `close()` (the unconditional-refocus callback) is deleted; the hook now owns Esc-refocus.
- The `onBlur` tab-away close and the `q`-reset-on-close effect stay local and unchanged.
- Behavior deltas: outside click no longer refocuses the trigger (decision 1). Escape's
  reach is unchanged (the current listener is already document-level); the real Escape
  delta is the hook's `defaultPrevented` skip-guard (an Escape another widget consumed no
  longer closes the facet), plus mousedown → pointerdown for outside dismissal (decision 3).
- Tests (file currently has **no** dismissal coverage — add): Escape closes and refocuses
  the trigger; outside click closes and does **not** refocus the trigger; Tab-away blur
  closes (pins the preserved local semantic).

### `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionMenu.tsx` (+ parent + test)

- The hook lives in **`ReviewActionButton`** (the owner of the open state):
  `useDismissableMenu({ open: menuOpen && !face.frozen, rootRef: rootDivRef,
  returnFocusRef: chevronRef, onClose: () => setMenuOpen(false) })`, where `rootDivRef` is
  a new ref on the existing `styles.root` wrapper div — main button, chevron, and mounted
  menu are all inside the boundary (decision 2).
- In `ReviewActionMenu`: delete the local Escape and `mousedown` document listeners. Keep a
  document `keydown` listener for **Tab only** (close without trapping, no refocus — ARIA
  APG; the hook does not handle Tab). Keep the empty-menu close effect and roving-focus
  `moveFocus`. The `triggerRef` prop is dropped (its only consumer was the deleted
  outside-click handler).
- `onClose` prop contract **shrinks to `onClose(): void`** — its remaining callers (Tab,
  empty-menu) both close without refocus, and Esc-refocus moved into the hook. In
  `ReviewActionButton`, `closeMenu` flattened to a bare `() => setMenuOpen(false)`
  (post-/simplify: the `{ restoreFocus }` option-bag had one caller left); the `onSelect`
  activation path closes and then focuses the chevron inline (parent-local semantic,
  unchanged behavior).
- `onMainClick` additionally calls `setMenuOpen(false)` on its `submit`/`resume` branches:
  with the main button now inside the boundary, the document listener no longer closes the
  menu when the main action fires, so the close is made explicit (preserves today's
  menu-closes-when-main-action-fires behavior).
- Behavior preserved: Escape closes + refocuses chevron (existing test stays green via the
  hook's deferred focus); outside click closes without refocus; Tab closes without refocus.
- Behavior fixed (deliberate, decision 2): clicking the main button in a 'change'/'none'
  face while the menu is open now closes it (was: close-then-reopen, menu stuck open).
- New tests: clicking the chevron while the menu is open closes it exactly once; clicking
  the main button in a 'change' (submitted) face while the menu is open closes it.

### `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx` (+ test)

- Replace the `confirmingClose`-gated `mousedown` effect with
  `useDismissableMenu({ open: confirmingClose, rootRef: containerRef, returnFocusRef:
  closeBtnRef, onClose: () => setConfirmingClose(false) })`; add `closeBtnRef` to the Close
  button (the morph's trigger).
- Delete the confirm span's local `onKeyDown` Escape handler — the hook owns Escape.
- Behavior deltas (both unifications, spelled out for review): Escape now cancels the
  close-confirm with focus anywhere (previously only with focus inside the span), and
  focus returns to the **Close** button (previously dropped to `<body>` when the span
  unmounted under the focused Cancel). The deferred-refocus timing works because
  `onClose` re-renders synchronously in the event, remounting the Close button before the
  `setTimeout(0)` focus fires — the same deferral the hook already relies on everywhere.
- Out of scope: `confirmingMerge` morph (own Escape flow), the focus-swap/`signature`
  machinery, the `sr-only` live region.
- Tests: existing Escape-cancels and outside-click-dismisses tests stay green
  (`userEvent`-driven). New: Escape cancels the confirm when focus is outside the panel,
  and focus lands on the Close button afterwards.

## Test strategy (TDD order)

Red-first per behavior change; mechanical moves ride on existing green tests as the
byte-faithfulness pin.

1. Hook: remove option + its test; run hook suite.
2. DiffSettingsMenu: flip the pinned outside-click test (**red**) → drop the option arg
   (**green**).
3. FilterFacet: add the three dismissal tests with the *new* outside-click expectation
   (outside-no-refocus **red** against current code) → adopt hook (**green**).
4. Select: adopt hook; existing suite green (no behavior change).
5. ReviewActionMenu/Button: add the chevron double-toggle guard (**green already** — pins
   current behavior) and the main-button-closes-open-menu test in a 'change' face (**red**
   against current code — the stuck-open quirk) → adopt hook in the parent + shrink
   contract (**green**); full existing suite green.
6. PrActionsPanel: add Escape-from-outside + Close-refocus test (**red**) → adopt (**green**).
7. `grep` guard: no `addEventListener('mousedown'` / hand-rolled Escape-dismiss remains in
   the four consumers.

## Acceptance criteria

- [x] All four newly-adopted consumers (Select, FilterFacet, ReviewActionButton/Menu,
      PrActionsPanel close-confirm) dismiss via `useDismissableMenu`; no hand-rolled
      document Escape/outside-dismiss listeners remain in them (grep-verified).
- [x] `returnFocusOnOutsideClose` no longer exists in runtime code or tests (grep-verified
      across `frontend/`). The identifier legitimately remains in the historical #328 design
      doc (`docs/specs/2026-07-02-328-modal-menu-chrome-design.md`), which records the design
      as shipped at that time.
- [x] All eight dismissable surfaces (existing adopters PrTabStrip, DiffSettingsMenu,
      IterationTabStrip, CommitMultiSelectPicker + the four adoptions): outside click
      closes without moving focus; Escape closes and refocuses the trigger.
- [x] Preserved local semantics (Select Tab/combobox model, FilterFacet blur-close,
      ReviewActionMenu Tab-close + empty-menu close, PrActionsPanel `confirmingClose`
      gating) each pinned by a test.
- [x] Full frontend suite green (`tsc -b`, lint, vitest 2775 across 333 files).
