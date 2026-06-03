import { useEffect } from 'react';
import type { RefObject } from 'react';

// #115 — locked side-by-side horizontal scroll. In split scroll-mode the two
// content panes are clipped (`overflow: hidden`) and a single synthetic
// scrollbar drives EVERY content cell's `scrollLeft` in lockstep, so the old
// and new halves of the same line always show the same columns (line tracking).
//
// Why this shape:
// - `overflow: hidden` (not `auto`) on cells: programmatic `scrollLeft` still
//   works, but the browser shows no per-cell scrollbar and the user can't
//   scroll an individual cell out of sync (no trackpad-over-one-cell desync).
// - One synthetic scrollbar (`bar`) is the single horizontal control; its
//   `scrollLeft` is mirrored onto every content cell on each scroll frame.
// - A `wheel` handler lets a trackpad / shift-wheel over the diff drive the bar.
export function useLockedPaneScroll(
  bodyRef: RefObject<HTMLElement | null>,
  scrollbarRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    const body = bodyRef.current;
    const bar = scrollbarRef.current;
    const spacer = spacerRef.current;
    if (!enabled || !body || !bar || !spacer) return;

    const contentCells = (): HTMLElement[] =>
      Array.from(body.querySelectorAll<HTMLElement>('td[data-side="old"], td[data-side="new"]'));

    const apply = (x: number): void => {
      for (const cell of contentCells()) cell.scrollLeft = x;
    };

    const measure = (): void => {
      let maxScroll = 0;
      let viewport = 0;
      for (const cell of contentCells()) {
        if (cell.scrollWidth > maxScroll) maxScroll = cell.scrollWidth;
        if (cell.clientWidth > viewport) viewport = cell.clientWidth;
      }
      const overflow = Math.max(0, maxScroll - viewport);
      // The bar's own width is the viewport; sizing the spacer to
      // `overflow + bar.clientWidth` makes the bar's max scrollLeft === overflow,
      // so dragging it fully reveals the longest line's end inside each pane.
      spacer.style.width = `${overflow + bar.clientWidth}px`;
      bar.style.visibility = overflow > 0 ? 'visible' : 'hidden';
      // Re-clamp the current offset after a re-measure (file switch / resize).
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
      // Only hijack predominantly-horizontal intent; let vertical scroll pass
      // through to the diff body.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      bar.scrollLeft += e.deltaX;
      e.preventDefault();
    };

    measure();
    bar.addEventListener('scroll', onBarScroll, { passive: true });
    body.addEventListener('wheel', onWheel, { passive: false });

    // jsdom (test env) has no ResizeObserver — guard so DiffPane split-mode
    // tests don't throw. Real browsers re-measure on container resize.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(body);
    }

    return () => {
      bar.removeEventListener('scroll', onBarScroll);
      body.removeEventListener('wheel', onWheel);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
    // `deps` lets the caller re-measure when the rendered diff content changes.
  }, [enabled, bodyRef, scrollbarRef, spacerRef, ...deps]);
}
