import { useEffect, useLayoutEffect } from 'react';

// Preserve the inner sub-tab-slot scroll position across keep-alive hide/show for the
// PR-detail Overview / Hotspots / Checks tabs (#643). Parallel mirror of
// diffScrollMemory.ts (#590) — kept separate, not generalized, to leave the proven
// Files diff-scroll path's contract untouched (the accepted cost is the duplicated
// `scrollHeight > clientHeight` clamp guard below, which must stay in lockstep with
// #590's).
//
// Root cause (same family as #590): #640 pins the header for these tabs by stamping a
// `data-detail-active` marker on `[data-app-scroll]`, which makes the visible
// `[data-detail-active] [data-subtab]:not([hidden])` SLOT the bounded internal scroller
// (`overflow-y:auto`). On a sub-tab switch / view deactivation the slot loses that
// bounded-scroller status — the `:not([hidden])` stops matching AND the marker effect's
// cleanup removes `data-detail-active` — so it reflows to full content height and the
// browser CLAMPS scrollTop to 0. (Plain `display:none` alone preserves scrollTop; the
// scroller-loss reflow is the trigger — the #590 finding.) A teardown-time read would
// already see 0, so a save-in-cleanup hook (useTabScrollMemory) cannot help here.
//
// Fix: record the live scrollTop on every scroll while the slot is a bounded scroller
// (capture), and write it back when the tab re-activates after the marker has been
// re-applied (restore). Keyed by `${refKey}|${subTab}` — one entry per (open PR,
// sub-tab), since a single PR has three independently-scrolled slots (this is the key
// difference from diffScrollMemory's refKey-only key).
const store = new Map<string, number>();

// The marker allow-list, single-sourced here so the marker effect (which makes the
// slot a scroller) and this hook (which restores onto it) cannot drift. Mirrors the
// `pinned` set in PrDetailView's marker layout effect and the tokens.css
// `[data-detail-active]` rules. Keep the list closed under PrDetailView's
// `effectiveSubTab` coercion (hotspots→overview) so the marker (fed raw subTab) and
// this hook (fed effectiveSubTab) stay in agreement.
export function isSlotScrollSubTab(subTab: string): boolean {
  return subTab === 'overview' || subTab === 'hotspots' || subTab === 'checks';
}

// Test-only: clear the module store between Vitest files (mirrors
// diffScrollMemory._clearDiffScrollStoreForTest — module isolation is per-file by
// default, but tests sharing a key would otherwise inherit a leftover offset).
export function _clearSlotScrollStoreForTest(): void {
  store.clear();
}

// Capture + restore for the active non-Files slot. Both sides scope to the view's own
// `rootRef` (pageRef) so two open PR tabs never cross-write, and target the exact
// `[data-subtab="<subTab>"]` slot (querySelector — `data-subtab` is unique per slot).
export function useSlotScrollMemory(opts: {
  rootRef: React.RefObject<HTMLElement | null>;
  refKey: string;
  // The effectiveSubTab from PrDetailView (the value that drives slot visibility),
  // so capture/restore target and key the slot actually shown.
  subTab: string;
  active: boolean;
}): void {
  const { rootRef, refKey, subTab, active } = opts;
  const key = `${refKey}|${subTab}`;
  const inScope = isSlotScrollSubTab(subTab);

  // CAPTURE — attach a scroll listener to the active slot and record its scrollTop on
  // every scroll. Re-acquires the slot whenever `subTab` changes (the slot is acquired
  // from the parent via querySelector, not a stable child ref). No active-gate: scroll
  // events only fire while the slot is visible, and the clamp-to-0 fired on switch-away
  // is dropped by the `scrollHeight > clientHeight` guard (the slot is unbounded —
  // scrollHeight <= clientHeight — at that instant, exactly as #590's body is).
  useEffect(() => {
    if (!inScope) return;
    const slot = rootRef.current?.querySelector<HTMLElement>(`[data-subtab="${subTab}"]`);
    if (!slot) return;
    const onScroll = () => {
      if (slot.scrollHeight > slot.clientHeight) store.set(key, slot.scrollTop);
    };
    slot.addEventListener('scroll', onScroll, { passive: true });
    return () => slot.removeEventListener('scroll', onScroll);
  }, [rootRef, key, subTab, inScope]);

  // RESTORE — on the activation edge (or a sub-tab switch back into scope), write the
  // stored offset back onto this view's slot. MUST be declared after the
  // `data-detail-active` marker layout effect in PrDetailView (this hook is called
  // after useDiffScrollRestore, which is after the marker) so the slot is a bounded
  // scroller again when the write lands — the write forces a synchronous reflow that
  // applies the just-set marker, so it sticks with no visible jump (same as #590).
  useLayoutEffect(() => {
    if (!active || !inScope) return;
    const slot = rootRef.current?.querySelector<HTMLElement>(`[data-subtab="${subTab}"]`);
    if (!slot) return;
    const saved = store.get(key);
    // saved === 0 (top) needs no write; the post-clamp slot is already at the top. A
    // saved offset beyond the current scroll range is clamped to max by the browser.
    if (saved != null && saved > 0) slot.scrollTop = saved;
  }, [active, key, subTab, inScope, rootRef]);
}
