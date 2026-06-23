import { useEffect, useLayoutEffect } from 'react';

// Preserve the inner diff-body scroll position across keep-alive hide/show (#590).
//
// Root cause (isolated live): when a PrDetailView deactivates, its layout-effect
// cleanup removes the `data-files-active` marker. That marker is what bounds
// `.diff-pane-body` into a fixed-height internal scroller; removing it — while the
// body is still laid out — reflows it to its full content height, so the browser
// CLAMPS scrollTop to 0. The clamp is synchronous and irrecoverable: re-adding the
// marker on return does not restore the lost offset, and a teardown-time read would
// already see 0. (Plain `display:none` alone preserves scrollTop; the marker removal
// is the trigger.) `useTabScrollMemory` does not help — it only tracks the OUTER
// `[data-app-scroll]` scroller, which is ~0 in files-active mode.
//
// Fix: record the live scrollTop on every scroll while visible (capture, owned by
// DiffPane where the body element is known to exist), and write it back when the
// pane re-activates (restore, owned by PrDetailView where the marker has just been
// re-applied so the body is bounded again).
//
// Keyed by prRefKey (one entry per open PR tab). Selection survives reactivation, so
// the current offset always belongs to the still-selected file; a genuine file switch
// resets scrollTop to 0 via DiffPane's own scroll-reset effect, which the capture
// listener records — so switching files correctly lands back at the top.
const store = new Map<string, number>();

// Test-only: clear the module store between Vitest files (mirrors
// useTabScrollMemory._clearStoreForTest — module isolation is per-file by default,
// but tests sharing a key would otherwise inherit a leftover offset).
export function _clearDiffScrollStoreForTest(): void {
  store.clear();
}

// CAPTURE — attach a scroll listener to the diff body and record its scrollTop on
// every scroll. Re-acquires the body whenever `bodyPresent` flips so a late first
// diff-load still gets a listener. No active-gate: scroll events only fire while the
// body is visible, so a backgrounded body never overwrites the stored offset.
export function useDiffScrollCapture(
  bodyRef: React.RefObject<HTMLElement | null>,
  key: string,
  bodyPresent: boolean,
): void {
  useEffect(() => {
    if (!bodyPresent) return;
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      // Ignore the clamp-to-0 scroll that fires when the data-files-active marker
      // is removed (deactivation / sub-tab switch away): at that instant the body
      // is no longer a bounded scroller (scrollHeight <= clientHeight), so its
      // scrollTop has collapsed to 0. Recording it would overwrite the real offset
      // we need to restore. Only genuine scrolls of a bounded body are recorded.
      if (body.scrollHeight > body.clientHeight) store.set(key, body.scrollTop);
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, [bodyRef, key, bodyPresent]);
}

// RESTORE — on the activation edge (or a sub-tab switch back to Files), write the
// stored offset back onto this view's diff body. MUST be declared AFTER the
// `data-files-active` marker layout effect in PrDetailView: React runs layout-effect
// setups in declaration order within a component, so by the time this runs the marker
// has been re-applied and the body is a bounded scroller again — the write sticks with
// no visible jump and no requestAnimationFrame dance.
export function useDiffScrollRestore(opts: {
  rootRef: React.RefObject<HTMLElement | null>;
  refKey: string;
  subTab: string;
  active: boolean;
}): void {
  const { rootRef, refKey, subTab, active } = opts;
  useLayoutEffect(() => {
    // Only the active view showing Files has a bounded diff body to restore.
    if (!active || subTab !== 'files') return;
    const root = rootRef.current;
    if (!root) return;
    const body = root.querySelector<HTMLElement>('.diff-pane-body');
    if (!body) return;
    const saved = store.get(refKey);
    // saved === 0 (top) needs no write; the post-clamp body is already at the top.
    if (saved != null && saved > 0) body.scrollTop = saved;
  }, [active, subTab, refKey, rootRef]);
}
