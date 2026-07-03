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

Non-goals: the merge-confirm morph in `PrActionsPanel` (its Escape/focus flow is #566
machinery, untouched); any DOM/CSS restructuring (pixel-identical rendering); the
focus-return unification for *Escape* (already uniform).

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
2. **Trigger is never "outside":** the hook's outside-pointerdown containment check widens
   from `rootRef.contains(target)` to `rootRef.contains(target) ||
   returnFocusRef.current?.contains(target)`. Rationale: a pointerdown on the trigger must
   not count as an outside dismissal — the trigger's own `onClick` owns the open/close
   toggle, and treating it as outside produces close-then-reopen double-toggling when the
   trigger sits outside `rootRef` (the `ReviewActionMenu` case). For all existing adopters
   the trigger is already inside `rootRef`, so this is behavior-neutral for them. This
   replaces the "small hook extension" the issue anticipated — no API change.
3. **`mousedown` → `pointerdown`:** three of the four consumers listen on `mousedown` today;
   the hook uses `pointerdown`. All existing tests drive dismissal via `userEvent.click`
   (which fires pointerdown), so no test churn from the event-type change.
4. **Escape `preventDefault` delta (ReviewActionMenu, PrActionsPanel close-confirm):** both
   currently `preventDefault()` the Escape that closes them; the hook deliberately does not
   (its contract: skip an Escape someone else consumed, never consume one itself). After
   adoption their Escape matches the four existing adopters. No document-level listener in
   the app keys on `defaultPrevented` for anything *other* than this hook's own skip-guard,
   so the only observable effect is unification.

## Changes by file

### `frontend/src/hooks/useDismissableMenu.ts`

- Delete `returnFocusOnOutsideClose` (option, doc comment, `close(returnFocusOnOutsideClose)`
  call site → `close(false)`, effect dep).
- Outside check becomes: close iff `rootRef.current` is non-null and neither `rootRef` nor
  `returnFocusRef` contains the target (decision 2).
- Doc comment updated: focus returns on Esc only; outside-click leaves focus at the target;
  the trigger is part of the boundary.

### `frontend/src/hooks/useDismissableMenu.test.tsx`

- Remove the `returnFocusOnOutsideClose` harness prop and its test.
- Existing "outside click closes without refocus" test stays (it is now the only behavior).
- New test: pointerdown on a trigger rendered *outside* `rootRef` (harness variant) does not
  fire `onClose` (decision 2 pin, guards the double-toggle regression).

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
- Behavior deltas: outside click no longer refocuses the trigger (decision 1); Escape now
  works with focus anywhere in the document, not only inside the facet (hook contract).
- Tests (file currently has **no** dismissal coverage — add): Escape closes and refocuses
  the trigger; outside click closes and does **not** refocus the trigger; Tab-away blur
  closes (pins the preserved local semantic).

### `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionMenu.tsx` (+ parent + test)

- The hook lives **inside `ReviewActionMenu`** (mounted-only-when-open, matching its current
  self-contained listener structure): `useDismissableMenu({ open: true, rootRef: ref,
  returnFocusRef: triggerRef ?? noopRef, onClose: () => onClose() })` where `noopRef` is a
  module-level `{ current: null }` used only when the optional `triggerRef` prop is absent.
- Delete the local Escape and `mousedown` document listeners. Keep a document `keydown`
  listener for **Tab only** (close without trapping, no refocus — ARIA APG; the hook does
  not handle Tab). Keep the empty-menu close effect and roving-focus `moveFocus`.
- `onClose` prop contract **shrinks to `onClose(): void`** — its remaining callers (Tab,
  empty-menu) both close without refocus, and Esc-refocus moved into the hook. In
  `ReviewActionButton`, `closeMenu` keeps its `{ restoreFocus }` shape for the `onSelect`
  activation path (parent-local semantic, unchanged) but the menu receives
  `onClose={() => closeMenu()}`.
- Behavior preserved: Escape closes + refocuses chevron (existing test stays green via the
  hook's deferred focus); outside click closes without refocus; chevron pointerdown does not
  double-toggle (decision 2); Tab closes without refocus.
- New test: clicking the chevron while the menu is open closes it exactly once (double-toggle
  guard at the consumer level).

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

1. Hook: add the trigger-outside-boundary test (**red**) → widen containment (**green**).
2. Hook: remove option + its test; run hook suite.
3. DiffSettingsMenu: flip the pinned outside-click test (**red**) → drop the option arg
   (**green**).
4. FilterFacet: add the three dismissal tests with the *new* outside-click expectation
   (outside-no-refocus **red** against current code) → adopt hook (**green**).
5. Select: adopt hook; existing suite green (no behavior change).
6. ReviewActionMenu/Button: add double-toggle guard test (**green already** — pins it),
   adopt hook + shrink contract; full existing suite green.
7. PrActionsPanel: add Escape-from-outside + Close-refocus test (**red**) → adopt (**green**).
8. `grep` guard: no `addEventListener('mousedown'` / hand-rolled Escape-dismiss remains in
   the four consumers.

## Acceptance criteria

- [ ] All four consumers dismiss via `useDismissableMenu`; no hand-rolled document
      Escape/outside-dismiss listeners remain in them.
- [ ] `returnFocusOnOutsideClose` no longer exists anywhere in the tree.
- [ ] All seven menus: outside click closes without moving focus; Escape closes and
      refocuses the trigger.
- [ ] Preserved local semantics (Select Tab/combobox model, FilterFacet blur-close,
      ReviewActionMenu Tab-close + empty-menu close, PrActionsPanel `confirmingClose`
      gating) each pinned by a test.
- [ ] Full frontend suite green (`tsc -b`, lint, vitest).
