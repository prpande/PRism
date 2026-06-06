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
  scrollbarRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    const bar = scrollbarRef.current;
    const spacer = spacerRef.current;
    if (!enabled || !viewport || !bar || !spacer) return;

    // One write per frame: .fileTreeInner reads this var via `transform: translateX`.
    const apply = (x: number): void => {
      viewport.style.setProperty('--file-tree-hscroll', `${x}px`);
    };

    const measure = (): void => {
      // viewport is overflow-x: hidden, so scrollWidth reports the full content width
      // (the max-content .fileTreeInner) and clientWidth is the visible column width.
      // .fileTreeInner's translateX is paint-time only and affects neither reading, so
      // `viewport` (not the bar) is the source of truth for the measured viewport width.
      const overflow = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      // Sizing the spacer to `overflow + bar.clientWidth` makes the bar's max scrollLeft
      // === overflow for ANY bar width — the bar is constrained to the tree column, so it
      // is narrower than the full pane, and the algebra still holds. Make the bar
      // measurable first (it may be display:none from a prior no-overflow measure), then
      // show it only when scrolling is needed so a tree that fits shows no empty strip.
      bar.style.display = 'block';
      spacer.style.width = `${overflow + bar.clientWidth}px`;
      bar.style.display = overflow > 0 ? 'block' : 'none';
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
  }, [enabled, viewportRef, scrollbarRef, spacerRef, ...deps]);
}
