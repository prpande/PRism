# #643 — Preserve Overview/Hotspots/Checks scroll position across tab switches

**Issue:** [#643](https://github.com/prpande/PRism/issues/643) · Follow-up from #640 (PR #642) · **Tier T2 · hands-off**

## Problem

#640 pinned the PR-detail header for Overview/Hotspots/Checks by stamping a
`data-detail-active` marker on `[data-app-scroll]`, which makes the visible
`[data-detail-active] [data-subtab]:not([hidden])` **slot** the bounded internal
scroller (`overflow-y:auto`). Consequence: switching away from one of those tabs
and back (or backgrounding the PR tab and returning) lands the slot **at the top** —
its `scrollTop` is not preserved.

- `useTabScrollMemory` tracks `[data-app-scroll].scrollTop`, not the slot, so it
  does nothing for these tabs (a no-op in browser mode — the slot scrolls, not the
  container).
- `useDiffScrollRestore` (#590) solves the equivalent problem for the **Files** tab's
  inner `.diff-pane-body`, but is hard-scoped to `subTab === 'files'` and the
  `.diff-pane-body` selector.

**Not a regression** (the issue is explicit): before #640 the document scrolled and
nothing restored it, so browser-mode scroll memory for these tabs was already
absent. Worth closing for **Files parity** and for the **Electron shell** (where
`[data-app-scroll]` scrolls and the *buggy* offset is currently remembered).

## Why the obvious fix is wrong

The issue suggests *either* parameterizing `useTabScrollMemory` with
`slotSelector='[data-subtab]:not([hidden])'` *or* a dedicated hook. The first is
**unsafe**: `useTabScrollMemory` saves `scrollTop` in its effect **cleanup**, but on a
tab switch the outgoing slot has, by cleanup time, **lost its bounded-scroller
status** — both the `:not([hidden])` no longer matches (React committed `hidden`) *and*
the marker effect's cleanup (declared earlier, so it runs first) removed
`data-detail-active`. Either alone strips the slot's `overflow-y:auto`, so it reflows to
full content height and the browser **clamps `scrollTop` to 0** — the *same* clamp #590
documents. (Per #590's isolated finding, plain `display:none` alone *preserves*
scrollTop; the scroller-loss reflow is the trigger, not the hide.) So a cleanup read
returns 0. `useTabScrollMemory` works for Files only because `[data-app-scroll]` is
*never* hidden or unbounded on a sub-tab switch (just the marker toggles, and the diff
body — not the container — is the inner scroller). The per-tab slot **is** unbounded by
the switch, so a save-in-cleanup read is always 0. The robust mechanism (proven by #590)
is **capture-on-scroll** (record the live value, ignore the clamp-to-0) plus an
**after-marker restore**.

## Approach (Option B — chosen)

New `frontend/src/hooks/slotScrollMemory.ts`, a parallel mirror of
`diffScrollMemory.ts`. **Alternative weighed (Option A): generalize `diffScrollMemory`
to serve both scrollers.** Against it on the merits — not the CSS DRIFT NOTE analogy:
the two hooks differ in (a) key shape (`refKey` vs `refKey|subTab`), (b) slot
acquisition (#590's capture is a DiffPane-owned `bodyRef`; the slot's is a
parent-side `rootRef.querySelector('[data-subtab]')`), and (c) the in-scope predicate.
A shared hook would have 2 consumers (above the speculative-abstraction floor), so the
generalization is legitimate; the chosen mirror's cost is a **duplicated
`scrollHeight > clientHeight` clamp guard** that must stay in lockstep with #590's.
Mirror was chosen (this slice) to keep **zero blast radius on the proven #590 Files
path**; the guard duplication is the accepted tradeoff.

### `isSlotScrollSubTab(subTab: PrTabId): boolean`

Shared predicate — `subTab === 'overview' || 'hotspots' || 'checks'`. Exported from
the new module and used in **both** the marker effect (replacing its inline
`pinned` computation) and the new hook, so the allow-list cannot drift between the
marker that makes the slot a scroller and the restore that writes to it.

### Module store

`Map<string, number>` keyed `` `${refKey}|${subTab}` `` (per open PR **and** per
sub-tab — distinct from `diffScrollMemory`'s `refKey`-only key, since one PR has
three independently-scrolled slots). Plus `_clearSlotScrollStoreForTest()`.

### `useSlotScrollMemory({ rootRef, refKey, subTab, active })`

`subTab` here is the **`effectiveSubTab`** value from `PrDetailView` (the one that
drives slot visibility: `hotspots→overview` when AI is off), so the hook targets and
keys by the slot actually shown.

- **Capture** (`useEffect`, passive — mirrors `useDiffScrollCapture`): when
  `isSlotScrollSubTab(subTab)`, find the slot via
  `rootRef.current.querySelector('[data-subtab="<subTab>"]')` and attach a passive
  `scroll` listener that records `scrollTop` **only when `scrollHeight > clientHeight`**
  (a bounded scroller). This guard drops the clamp-to-0 scroll that fires when
  `data-detail-active` is removed on switch-away (the #590 failure mode) and any
  read of a now-`display:none` slot.
- **Restore** (`useLayoutEffect`, mirrors `useDiffScrollRestore`): when `active &&
  isSlotScrollSubTab(subTab)`, write the stored offset back onto the slot, but only
  if `saved != null && saved > 0` (0/top needs no write). **Must be declared after
  the marker effect** so `data-detail-active` is already set and the slot is a
  bounded scroller when the write lands (no `requestAnimationFrame` needed — same as
  #590). Scoped to the view's own `pageRef` so two open PR tabs / the wrong slot are
  never targeted.

### Wiring in `PrDetailView`

Call `useSlotScrollMemory({ rootRef: pageRef, refKey, subTab: effectiveSubTab, active })`
**after** `useDiffScrollRestore` (hence after the marker effect). Extend the
"ORDER MATTERS" comment to list the 4th effect and its required position (after the
marker, like the other two restores).

**Marker + hook both compute from `effectiveSubTab`.** The marker effect's `pinned`
becomes `isSlotScrollSubTab(effectiveSubTab)` (and `data-files-active` keys on
`effectiveSubTab === 'files'`), matching the hook. `effectiveSubTab` is the value that
drives slot visibility (it coerces `hotspots→overview` when AI is off), so the marker
binds the shell for the slot the user actually sees and the two stay consistent by
construction — no "keep the allow-list closed under the coercion" invariant to maintain.
This is behavior-identical to keying the marker on raw `subTab` (the coercion only maps
one allow-listed value to another and never produces/removes `files`), so #640's pin is
unchanged.

## Acceptance criteria

1. Scroll Overview (and Hotspots, and Checks) down; switch to another sub-tab and
   back → the slot returns to its prior `scrollTop`, not the top.
2. Same across a PR-tab background/return (deactivate → reactivate).
3. Per-`(refKey, subTab)` isolation: each sub-tab and each open PR keeps its own
   offset; no cross-contamination.
4. A genuine scroll-back-to-top (offset 0) stays at top on return (no spurious
   restore).
5. Files inner-diff restore (#590) and the #640 header pin are unchanged.
6. Drafts (and any future non-allow-list tab) get no marker and no restore —
   unchanged document-scroll behavior.

## Testing

- **Unit (`slotScrollMemory.test.tsx`)** — mirror `diffScrollMemory.test.tsx`:
  capture→restore round-trip; per-key isolation (different sub-tabs, different PRs);
  0-stays-at-top; clamp-to-0 guard (marker-removal scroll not recorded — assert via the
  `scrollHeight === clientHeight` unbounded state, **not** `display:none`, per the
  corrected mechanism above); **re-acquire on sub-tab switch** (capture moves its
  listener to the new slot — explicitly exercise this, since the slot is parent-acquired
  via `querySelector`, not a stable child `bodyRef`); non-allow-list sub-tab is a no-op;
  restore scoped to `rootRef` (two mounted views; the wrong view's slot is untouched).
- **E2E (`e2e/detail-scroll-keepalive.spec.ts`)** — mirror
  `diff-scroll-keepalive.spec.ts`: scroll a tall Overview/Checks slot, switch
  sub-tab (and PR→Inbox→PR), assert `scrollTop` survives and
  `[data-app-scroll][data-detail-active]` is present on return. Use the `prod`
  Playwright project (dev can't run scenario hooks). Forcing slot overflow
  deterministically: shrink the viewport height (the slot's `min-height:360px` floor
  means a short viewport makes even modest tab content overflow the slot).
- **Regression gates (must stay green — AC5).** The change edits the *shared* marker
  layout-effect and inserts a 4th effect into the order-sensitive sequence, so the
  existing **`diff-scroll-keepalive.spec.ts` (#590 inner-diff restore)** and
  **`pr-detail-header-pinned.spec.ts` (#640 header pin, parameterized over the detail
  tabs)** are the named guards against a reorder/refactor regression — no new assertion
  needed, but both must remain green.

## Known limitations (accepted)

- **Content shrinks between save and return** (e.g. a collapsible Overview section
  closes): the saved offset may exceed the new `scrollHeight - clientHeight`. The
  browser clamps the write to max on its own, so the user lands at the bottom of the
  shorter content — identical to today's no-restore-on-shrink reality and to #590. No
  explicit `Math.min` clamp is added (it would be behaviorally inert against the
  browser's own clamp).
- **AI toggled off while parked-and-scrolled on Hotspots:** the Hotspots slot unmounts
  (`fileFocusEnabled && …`), stranding its `refKey|hotspots` offset; re-enabling AI
  remounts a fresh-loading Hotspots and a re-applied offset may clamp against the
  skeleton. This is an acceptable capability-change edge, not a tab-switch path; not
  worth an eviction-on-capability-loss mechanism.
- **No skeleton-race retry** (no `ResizeObserver`): verified that under keep-alive the
  slot content stays **mounted** on a tab switch (Checks is stale-while-revalidate;
  Overview/Hotspots don't re-enter `loading` on a CSS un-hide), so the restore never
  races an async content populate on the switch path. Matches #590 (no observer).

## Out of scope

- Touching `useTabScrollMemory` (its `[data-app-scroll]` behavior — incl. the
  Electron escape-hatch scroll — is unrelated and left as-is).
- Drafts scroll memory (no marker; opt-in later if it gains a slot scroller).
- Back-porting the content-shrink clamp / skeleton-retry to `diffScrollMemory` (#590):
  no evidence the Files diff body shrinks or re-skeletons in practice.
