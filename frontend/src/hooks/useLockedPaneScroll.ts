import { useEffect } from 'react';
import type { RefObject } from 'react';

// #115 — locked side-by-side horizontal scroll. In split scroll-mode the two
// content panes are clipped (`overflow: hidden`) and a single synthetic
// scrollbar drives a UNIFORM shift of every content cell, so the old and new
// halves of the same line always show the same columns (line tracking).
//
// Why a CSS variable + `transform: translateX`, not per-cell `scrollLeft`:
//   per-cell `scrollLeft` clamps to each cell's own overflow, so SHORT lines
//   (no overflow) stay put while only long lines move — a ragged, non-scroll
//   feel (PR #149 validation). Setting one `--diff-hscroll` var on the body and
//   keying every cell's `transform: translateX` off it shifts ALL lines by the
//   same amount, so the whole pane scrolls as a unit. (Was `text-indent`, which
//   only offsets a line's first-line start and rendered raggedly across
//   variable-width `white-space: pre` lines in a real browser — #155.) One
//   style write per frame, and
//   the clip (`overflow: hidden`, not `auto`) means no per-cell scrollbar and no
//   trackpad-over-one-cell desync. A `wheel` handler lets a trackpad /
//   shift-wheel over the diff drive the bar.
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

    // One write per frame: every content cell reads this var via `transform: translateX`.
    const apply = (x: number): void => {
      body.style.setProperty('--diff-hscroll', `${x}px`);
    };

    const measure = (): void => {
      // Reset the shift to zero before reading each cell's content width.
      // `transform: translateX` doesn't affect scrollWidth (paint-time only),
      // so this is now defensive rather than load-bearing — but it keeps the
      // measured baseline unambiguous and costs nothing.
      apply(0);
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
      // Make the bar measurable first (it may be display:none from a prior
      // no-overflow measure), then show it ONLY when scrolling is needed so a
      // file that fits shows no empty bottom strip.
      bar.style.display = 'block';
      spacer.style.width = `${overflow + bar.clientWidth}px`;
      bar.style.display = overflow > 0 ? 'block' : 'none';
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
      // Clear the offset so a stale non-zero value can't briefly shift content
      // when locked scroll is re-enabled (e.g. toggling wrap off) before the
      // next measure() resets it (Copilot PR #149 review).
      body.style.removeProperty('--diff-hscroll');
    };
    // `deps` lets the caller re-measure when the rendered diff content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied `...deps` re-measure key; a spread element can't be statically verified (#331)
  }, [enabled, bodyRef, scrollbarRef, spacerRef, ...deps]);
}
