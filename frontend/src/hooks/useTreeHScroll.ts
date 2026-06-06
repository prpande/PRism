import { useEffect } from 'react';
import type { RefObject } from 'react';

// #214 — synthetic, bottom-pinned horizontal scrollbar for the file tree, mirroring the
// diff pane's useLockedPaneScroll mechanism. The tree's horizontal viewport
// (.fileTreeScroll) is clipped (overflow-x: hidden); a synthetic scrollbar's scrollLeft
// drives a `--file-tree-hscroll` CSS var on the viewport, which .fileTreeInner reads via
// `transform: translateX` — so the whole tree shifts as one unit and the bar (a sticky
// footer OUTSIDE the scroller) stays pinned at the bottom of the visible pane, reachable
// without scrolling the tree to its end.
//
// Deliberately NOT a generalization of useLockedPaneScroll. The diff shifts N table cells
// in lockstep and its per-cell measurement is the bulk of that hook's complexity, whereas
// the tree shifts ONE element with a trivial measurement (viewport.scrollWidth vs
// clientWidth). Folding the tree into that hook would refactor the diff's load-bearing
// measurement to serve a structurally-simpler one-off and widen the diff-regression
// surface on a gated UI change. This reuses the *pattern* (rAF-throttled scrollLeft → CSS
// var, horizontal-intent wheel handling, jsdom-guarded ResizeObserver, spacer sizing +
// display toggle, clamp-on-resize), not the code. (#214 spec, adversarial review A4.)
export function useTreeHScroll(
  viewportRef: RefObject<HTMLElement | null>,
  rowRef: RefObject<HTMLElement | null>,
  scrollbarRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    const row = rowRef.current;
    const bar = scrollbarRef.current;
    const spacer = spacerRef.current;
    if (!enabled || !viewport || !row || !bar || !spacer) return;

    // One write per frame: .fileTreeInner reads this var via `transform: translateX`.
    const apply = (x: number): void => {
      viewport.style.setProperty('--file-tree-hscroll', `${x}px`);
    };

    const measure = (): void => {
      // viewport (.fileTreeScroll) is overflow-x: hidden and never display:none, so it is
      // always measurable: scrollWidth reports the full content width (the max-content
      // .fileTreeInner) and clientWidth is the visible column width. .fileTreeInner's
      // translateX is paint-time only and affects neither reading.
      const overflow = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      // Toggle the whole footer ROW (not just the bar), so when the tree fits NOTHING —
      // not even the row's 1px top border — is left pinned at the pane bottom. The bar is
      // ~the viewport width (both are the flex:1 tree column beside a same-width fixed
      // sibling), so sizing the spacer from viewport.clientWidth yields the same
      // bar.maxScrollLeft === overflow without needing the bar visible to measure it.
      row.style.display = overflow > 0 ? 'flex' : 'none';
      spacer.style.width = `${overflow + viewport.clientWidth}px`;
      // Re-clamp the current offset after a re-measure (file-list change / resize).
      if (bar.scrollLeft > overflow) bar.scrollLeft = overflow;
      apply(bar.scrollLeft);
    };

    let raf = 0;
    const onBarScroll = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply(bar.scrollLeft);
      });
    };

    const onWheel = (e: WheelEvent): void => {
      // Only hijack predominantly-horizontal intent; let vertical scroll pass through to
      // the outer tree pane (.filesTabTree owns vertical scrolling).
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      bar.scrollLeft += e.deltaX;
      e.preventDefault();
    };

    measure();
    bar.addEventListener('scroll', onBarScroll, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: false });

    // jsdom (test env) has no ResizeObserver — guard so unit tests don't throw. Real
    // browsers re-measure on pane resize.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(viewport);
    }

    return () => {
      bar.removeEventListener('scroll', onBarScroll);
      viewport.removeEventListener('wheel', onWheel);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      // Clear the offset so a stale value can't briefly shift content if the hook
      // re-enables before the next measure() resets it.
      viewport.style.removeProperty('--file-tree-hscroll');
    };
    // `deps` lets the caller re-measure when the rendered row set changes.
  }, [enabled, viewportRef, rowRef, scrollbarRef, spacerRef, ...deps]);
}
