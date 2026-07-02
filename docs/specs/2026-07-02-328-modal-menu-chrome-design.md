# #328 — One focus-trap hook, one dismissable-menu hook, adopt `--scrim`

**Issue:** [#328](https://github.com/prpande/PRism/issues/328) (2026-06 code-quality epic #317). **Tier:** T2, machine doc-review (1×) substitutes the spec gate. **Risk:** split — **PR A** (hooks + banner utilities) is hands-off; **PR B** (scrim/shadow token adoption) is **gated B1** (deliberate dark-mode visual change; before/after screenshots for the human eyeball-assert after green-and-ready).

**Premises re-verified against main 2026-07-02** — all four issue claims hold. New since June (out of scope, see Follow-up): four more hand-rolled dismissal implementations (`controls/Select.tsx`, `Inbox/filters/FilterFacet.tsx`, `ReviewActionButton/ReviewActionMenu.tsx`, `OverviewTab/PrActionsPanel.tsx`). Both menus have existing tests under `frontend/__tests__/` (the repo's second test dir): `CommitMultiSelectPicker.test.tsx` pins Escape-close (`:73-85`); `IterationTabStrip.test.tsx` pins dropdown rendering only.

## PR A — shared hooks + banner utilities (hands-off)

### 1. `useModalFocusTrap` (new: `frontend/src/hooks/useModalFocusTrap.ts`)

The `FOCUSABLE` selector string, Tab trap, and focus-capture/restore effect exist byte-near-identically in four files: `Modal/Modal.tsx` (`FOCUSABLE_SELECTOR` :35, trap :70-101, restore :54-66), `Settings/SettingsModal.tsx` (:6, :48-72, :29-46), `Help/HelpModal.tsx` (:17, :97-121, :78-95), `Feedback/FeedbackModal.tsx` (:9, :191-216, :159-179). Drift is real: Modal lacks the fallback-selector restore; Feedback guards Esc with a dirty check.

One hook, composed by all four, preserving each consumer's exact current behavior:

```ts
export const FOCUSABLE_SELECTOR = /* the existing shared string */;
export function useModalFocusTrap(
  dialogRef: RefObject<HTMLElement>,
  opts: {
    active: boolean;                       // trap only while open/visible
    onEscape?: () => void;                 // omit = Esc ignored (Modal's disableEscDismiss)
    restoreFallbackSelector?: string;      // omit = restore to previously-focused only (Modal today)
    initialFocus?: () => HTMLElement | null; // consumer picks first focus (Modal's [data-modal-role], Feedback's first radio)
  },
): void;
```

- Behavior inside: capture `document.activeElement` when `active` flips true; focus `initialFocus()` result or first `FOCUSABLE_SELECTOR` match; keydown listener handling Tab-cycle and Esc → `opts.onEscape`; on deactivate/unmount, restore to the captured opener, else `restoreFallbackSelector` match, else nothing — matching the Settings/Help/Feedback fallback chain, with the fallback simply omitted for Modal.
- Feedback keeps its dirty-guard by passing `onEscape: requestClose`. Modal keeps `disableEscDismiss` by conditionally omitting `onEscape`. **Important existing invariant** (memory + `Modal.tsx` docs): Modal's `onClose` fires **only** on Escape — no scrim click, no X; the hook must not add dismissal paths to Modal.
- The scrim pointerdown/pointerup same-target guard (`scrimDownTarget`) is also triplicated in Settings/Help/Feedback — extract, in the same file:

  ```ts
  export function useScrimDismiss(onDismiss: () => void): {
    onPointerDown: (e: React.PointerEvent) => void;  // records e.target when it IS the scrim element itself
    onPointerUp: (e: React.PointerEvent) => void;    // fires onDismiss only when down+up hit the same scrim target
  };
  ```

  Plain per-render handlers over a ref (no document listeners, nothing to unsubscribe); `onDismiss` may change identity freely (Feedback passes `requestClose`, which closes over dirty state). Modal does not consume it (no scrim-click close today). Covered by `useModalFocusTrap.test.tsx`'s sibling cases or the modal suites — the trap-hook test file gains a `useScrimDismiss` describe block.
- **Callback identity rule for the trap hook:** `FeedbackModal`'s `requestClose` closes over `{dirty, modalState.kind}` and is recreated every render (trap deps today at `:216`) — the hook reads `onEscape`/`initialFocus` through a latest-ref so consumers can pass fresh closures without re-subscribing document listeners.
- Modal's keep-alive gotcha (memory: listeners keyed on `open` leak under `hidden`) — the hook keys everything on `opts.active`, preserving the current `open`-keyed semantics exactly; no new listener lifetimes.

### 2. `useDismissableMenu` (new: `frontend/src/hooks/useDismissableMenu.ts`)

Four menus, four behaviors today (verified): `DiffSettingsMenu` (Esc ✅, outside-pointerdown ✅, focus-return ✅), `CommitMultiSelectPicker` (Esc ✅, outside ❌, focus-return ✅), `IterationTabStrip` (❌/❌/❌), `PrTabStrip` (Esc ✅, outside-mousedown ✅, focus-return via `querySelector` class lookup :87).

```ts
export function useDismissableMenu(opts: {
  open: boolean;
  rootRef: RefObject<HTMLElement>;      // outside-click boundary (trigger + popup)
  returnFocusRef: RefObject<HTMLElement>; // the trigger button
  onClose: () => void;                  // consumer state setter
  returnFocusOnOutsideClose?: boolean;  // default false; DiffSettingsMenu passes true
}): void;
```

- Esc keydown (document-level, only while `open`; no `preventDefault` — PrTabStrip's current `preventDefault` is dropped, nothing observable listens for default Esc and no test pins it), outside **pointerdown** (unifying DiffSettingsMenu's pointerdown and PrTabStrip's mousedown — pointerdown fires first and covers the same gesture), and focus return to `returnFocusRef` on close-by-Esc always, on close-by-outside-click only when `returnFocusOnOutsideClose` — DiffSettingsMenu's outside-click focus return is pinned behavior (`DiffSettingsMenu.test.tsx:48-54` "returns focus to the gear"; its `close()` refocuses unconditionally), the other three don't return focus on outside-click today, and this PR preserves both rather than silently changing either. Whether to unify that UX detail later goes to the follow-up issue. Focus-return timing keeps DiffSettingsMenu's `setTimeout(0)` deferral — `CommitMultiSelectPicker`'s Esc refocus therefore moves from synchronous to deferred (no test asserts the timing; new tests are written against the deferred behavior with real timers/`await`, per the repo's fake-timer trap).
- **Deliberate Esc-scope widening (stated, not hidden):** DiffSettingsMenu's Esc today is a root `onKeyDown` + `stopPropagation` (fires only with focus inside); it moves to document-level, matching PrTabStrip — Esc anywhere while the menu is open now closes it. CommitMultiSelectPicker's local `case 'Escape':` is removed (the hook owns Esc; its existing test fires keydown on the listbox, which bubbles to document and stays green); its arrow-key handling stays local (not the hook's job).
- Adoption is the behavior fix the issue's acceptance demands: `CommitMultiSelectPicker` gains outside-click close; `IterationTabStrip` gains all three — its `rootRef` boundary is the `.iteration-tab-overflow` div wrapping trigger + dropdown (`IterationTabStrip.tsx:79`), NOT the whole strip (inline-tab clicks must count as outside); `PrTabStrip` swaps the class-name `querySelector` for a ref.
- **IterationTabStrip ARIA popup semantics land with the adoption:** the trigger gains `aria-haspopup` + `aria-controls`, the dropdown gains `role`/labeling matching PrTabStrip's `menu`/`menuitem` pattern — document-level dismissal without the popup semantics would upgrade only sighted users.
- These are interaction changes assertable by unit tests (not B1 — nothing rendered changes).

### 3. Banner utilities

`.bannerRefreshMessage` / `.bannerReconcileMessage` / `.crossTabPresenceBannerMessage` are each exactly `{ flex: 1; min-width: 0; }`; `.bannerRefreshActions` ≡ `.crossTabPresenceBannerActions`. Add `.banner-message` / `.banner-actions` next to the existing global `.banner` (`tokens.css:818`), swap the three components' classNames, delete the module rules. Pixel-identical.

### PR A testing

- New `useModalFocusTrap.test.tsx`: Tab cycles at both edges, Esc routing (present/absent), capture/restore, fallback-selector path, `active:false` inert; plus a `useScrimDismiss` describe block (same-target fires, cross-target doesn't).
- New `useDismissableMenu.test.tsx`: Esc close + focus return, outside-pointerdown close without focus steal (default) and with `returnFocusOnOutsideClose`, no listeners when closed.
- Existing `Modal.test.tsx` / `SettingsModal.test.tsx` / `HelpModal.test.tsx` / `FeedbackModal.test.tsx` / `DiffSettingsMenu.test.tsx` / `PrTabStrip.test.tsx` / `__tests__/CommitMultiSelectPicker.test.tsx` / `__tests__/IterationTabStrip.test.tsx` stay green **unmodified** (they pin the preserved behavior, incl. Feedback's dirty-guard, DiffSettingsMenu's outside-click focus return, and the picker's Escape-close).
- New specs covering only the newly-gained behaviors: `CommitMultiSelectPicker` outside-click close; `IterationTabStrip` Esc/outside/focus-return + ARIA popup attributes.

## PR B — token adoption (gated B1)

- Point six scrims at `var(--scrim)` (defined `tokens.css:194` light `oklch(0.20 0.01 250 / 0.32)`, `:293` dark `oklch(0 0 0 / 0.55)`; currently **zero consumers**): `.modal-backdrop` (`tokens.css:953`, now 0.45), Settings/Help/Feedback module `.scrim` (0.45 ×3), `NoReposWarningModal` `.backdrop` (0.5), `HostChangeModal` `.modal` (0.4). **Excluded:** `Cheatsheet.module.css` `.backdrop` (0.08) — non-modal panel, intentionally light.
- `.modal-dialog` box-shadow (`tokens.css:968`) → `var(--shadow-modal)` (defined :192/:291; already consumed by Cheatsheet and the Settings/Help/Feedback module CSS — `.modal-dialog` is the last modal shadow off-token, so only Modal-based dialogs see a shadow change).
- Visual result: light scrims get slightly lighter/blue-tinted (0.45 black → 0.32 dark-blue); dark scrims get darker (→ 0.55) — the token's intent. Screenshots in both themes go in the PR body for **at minimum NoReposWarningModal (largest delta, 0.5→0.32) and one Modal-family instance, e.g. SubmitDialog (the most-reused 0.45 baseline)** — not one implementer-chosen "representative"; pause at green-and-ready for the B1 eyeball-assert.
- Deliberate scope cut (stated): HostChangeModal's and NoReposWarningModal's own box-shadow rules (rgba 0.2/0.3) stay hardcoded — acceptance covers scrims plus `.modal-dialog`'s shadow only.
- e2e note: visual parity baselines run CI(Linux)-only at 2% maxDiffPixelRatio. Known-affected: `settings-modal-visual.spec.ts` full-page shots (`settings-appearance-{theme}`, `settings-ghc-{theme}`, `settings-narrow`) — the scrim retint covers most of the frame; regen those baselines from the CI artifact into the same PR (per repo practice). `ai-onboarding-visual.spec.ts` is element-clipped and likely unaffected; audit the rest at implementation time.

## Follow-up (filed at PR-A time, not implemented)

New issue: migrate the four post-June dismissal copies (`Select.tsx`, `FilterFacet.tsx`, `ReviewActionMenu.tsx`, `PrActionsPanel.tsx`) to `useDismissableMenu`, preserving their extra semantics (Select's Tab handling, FilterFacet's blur-close, ReviewActionMenu's `restoreFocus` contract). Mechanical adoption, kept out to hold this at T2. The same issue carries the open UX question of whether DiffSettingsMenu's outside-click focus return (`returnFocusOnOutsideClose: true`, pinned by its test) should unify with the others' no-return behavior — a human design call, not silently decided here.

## Acceptance (issue, re-scoped)

1. One `FOCUSABLE_SELECTOR` + one trap hook; four modals compose it; existing a11y tests green unmodified. (PR A)
2. Four menus close on Esc **and** outside-click with focus return via one hook; PrTabStrip ref-based. (PR A)
3. Banner utilities replace the triplicated blocks. (PR A)
4. Zero hardcoded modal scrim colors; dark scrim uses the token; `.modal-dialog` uses `var(--shadow-modal)`; screenshots (NoReposWarningModal + a Modal-family dialog, both themes) in PR. (PR B)

## Risks

- **Trap-hook unification silently changing edge behavior** (e.g., Modal's `defaultFocus` order, Feedback's second focus effect at :183-188). Mitigation: consumers keep their bespoke effects where they aren't part of the shared machinery; existing tests must pass unmodified.
- **pointerdown vs mousedown unification** could alter PrTabStrip outside-close ordering relative to other mousedown listeners. Covered by `PrTabStrip.test.tsx`; if a test pins `mousedown` specifically, the hook still closes the menu on the same user gesture — update only the event name in the test if needed (behavior, not contract, is the guard).
- **Scrim token adoption is intentionally visible** — that's the B1 gate's job.
