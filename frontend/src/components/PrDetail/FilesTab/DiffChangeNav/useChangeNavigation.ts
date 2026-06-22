import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DiffChange, ChangeTick } from './diffChanges';
import { computeCurrentIdx, computeTicks } from './diffChanges';

const SCROLL_MARGIN = 8;
// Safety net only: clears the programmatic-scroll flag if neither arrival-at-target
// nor a user gesture has done so (generous, so it never fires mid-animation).
const ANIM_CAP_MS = 1200;

// Scroll offset that lands change `startTop` just below the top edge (by
// SCROLL_MARGIN), clamped to the scrollable range. Shared by the deliberate
// jump (goToChange) and the mid-jump re-aim (remeasure).
function scrollTargetFor(startTop: number, scrollHeight: number, clientHeight: number): number {
  const maxTop = Math.max(0, scrollHeight - clientHeight);
  return Math.min(maxTop, Math.max(0, startTop - SCROLL_MARGIN));
}

// Programmatic scroll, honoring prefers-reduced-motion (instant instead of smooth).
function scrollContainerTo(c: HTMLElement, top: number): void {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  c.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}

export interface ChangeNavState {
  total: number;
  currentIdx: number; // -1..total-1
  canPrev: boolean;
  canNext: boolean;
  hasOverflow: boolean;
  ticks: ChangeTick[];
  viewport: { topPct: number; heightPct: number };
  // Vertical scrollbar width of the scroll container (offsetWidth − clientWidth);
  // 0 with overlay scrollbars. The minimap rail offsets its right edge by this so
  // an expanded rail never sits on top of (and blocks) the scrollbar.
  scrollbarW: number;
  goToPrev: () => void;
  goToNext: () => void;
  goToChange: (i: number) => void;
  scrollToRatio: (r: number) => void;
  remeasure: () => void;
}

interface Measured {
  startTops: number[];
  measured: { top: number; heightPx: number }[];
  scrollHeight: number;
  clientHeight: number;
  scrollbarW: number;
}

function measure(container: HTMLElement, changes: DiffChange[]): Measured {
  const cRect = container.getBoundingClientRect();
  const startTops: number[] = [];
  const measured: { top: number; heightPx: number }[] = [];
  for (let i = 0; i < changes.length; i++) {
    const startEl = container.querySelector<HTMLElement>(`[data-change-start="${i}"]`);
    if (!startEl) {
      startTops.push(0);
      measured.push({ top: 0, heightPx: 0 });
      continue;
    }
    const startRect = startEl.getBoundingClientRect();
    // Reference-frame-agnostic: viewport delta + current scrollTop.
    const top = startRect.top - cRect.top + container.scrollTop;
    // Measure the run's ACTUAL rendered pixel span (start row top → end row bottom).
    // This handles split-mode pairing (del+ins collapse into one <tr>, so rendered
    // rows != allLines count) and wrapped/variable-height rows — both of which make
    // `rowCount * firstRowHeight` wrong. Fall back to the start row's own height when
    // no end row is tagged.
    const endEl = container.querySelector<HTMLElement>(`[data-change-end="${i}"]`);
    const endRect = (endEl ?? startEl).getBoundingClientRect();
    startTops.push(top);
    measured.push({ top, heightPx: Math.max(0, endRect.bottom - startRect.top) });
  }
  return {
    startTops,
    measured,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    scrollbarW: Math.max(0, container.offsetWidth - container.clientWidth),
  };
}

export function useChangeNavigation(
  containerRef: RefObject<HTMLElement | null>,
  tableRef: RefObject<HTMLElement | null>,
  changes: DiffChange[],
  // Stable identity of the rendered view (file path + whole-file mode). The
  // top-reset keys on THIS, not on the `changes` array reference: `changes`
  // recomputes for the SAME file whenever `allLines` does (whole-file async
  // load, a parent `files` re-fetch handing DiffPane a fresh `selectedFile`),
  // and keying the reset on that churn wiped `currentIdx` mid-navigation (#577).
  // REQUIRED, and must change ONLY on a genuine view swap: a value that never
  // changes makes the reset fire once on mount and never again; a value that
  // churns for the same view reintroduces #577. Typed `string` (not `unknown`)
  // so the compiler rejects passing the `changes` array or an object identity —
  // the exact mistake this fix exists to prevent. Compared by value (a fresh
  // string with the same contents does NOT re-fire the reset).
  resetKey: string,
): ChangeNavState {
  const [snap, setSnap] = useState<Measured>({
    startTops: [],
    measured: [],
    scrollHeight: 0,
    clientHeight: 0,
    scrollbarW: 0,
  });
  const [scrollTop, setScrollTop] = useState(0);
  // currentIdx is authoritative STATE, not re-derived from scrollTop each render.
  // A jump sets it directly (deterministic — independent of where the settled
  // scrollTop rounds relative to the activation margin); a genuine MANUAL scroll
  // recomputes it from position. The two are kept apart by `animatingRef`.
  const [currentIdx, setCurrentIdx] = useState(-1);
  // True while a programmatic scroll-to is in flight. Cleared on arrival at the
  // target, on a user scroll gesture (wheel/touch/pointer), or by the safety cap
  // — so trailing animation-frame scroll events never overwrite currentIdx.
  const animatingRef = useRef(false);
  const targetTopRef = useRef(0);
  const animCapRef = useRef(0);
  const rafRef = useRef(0);
  // Latest measurement, read by the long-lived scroll/jump handlers without
  // re-subscribing them every time the snapshot changes.
  const snapRef = useRef(snap);
  snapRef.current = snap;
  // Latest index, read by `remeasure` to re-aim an in-flight jump WITHOUT taking
  // currentIdx as a callback dep (that would re-measure on every navigation step).
  const currentIdxRef = useRef(currentIdx);
  currentIdxRef.current = currentIdx;

  const remeasure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const m = measure(c, changes);
    setSnap(m);
    setScrollTop(c.scrollTop);
    // Keep currentIdx consistent with the new geometry while parked (not mid-jump).
    if (!animatingRef.current) {
      setCurrentIdx(computeCurrentIdx(m.startTops, c.scrollTop, SCROLL_MARGIN));
      return;
    }
    // Mid-jump: a same-file `changes` recompute (whole-file load / parent
    // re-fetch) shifted the content height under the running smooth scroll (#577).
    // Two corrections, since the index-reset no longer fires on every recompute:
    //   1. Clamp the pinned index into the new bounds so the counter can never
    //      read "N of M" with N > M when the change set shrank.
    //   2. Re-aim targetTopRef at the target row's NEW top (and re-issue the
    //      scroll) so the jump still settles via the arrival check instead of
    //      waiting out ANIM_CAP_MS against a now-stale target.
    const last = m.startTops.length - 1;
    const i = Math.min(currentIdxRef.current, last);
    if (i !== currentIdxRef.current) setCurrentIdx(i);
    if (i < 0) return;
    const top = scrollTargetFor(m.startTops[i], m.scrollHeight, m.clientHeight);
    if (Math.abs(top - targetTopRef.current) > 2) {
      targetTopRef.current = top;
      scrollContainerTo(c, top);
    }
  }, [containerRef, changes]);

  // Measure after paint + whenever the change list changes.
  useLayoutEffect(() => {
    remeasure();
  }, [remeasure]);

  // ResizeObserver on content table (height changes from syntax/annotations/comments
  // /allLines) AND the scroll container (clientHeight when the hscroll bar appears).
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return; // jsdom: rely on deps-array remeasure
    const ro = new ResizeObserver(() => remeasure());
    if (tableRef.current) ro.observe(tableRef.current);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [remeasure, tableRef, containerRef]);

  // Scroll + gesture tracking (rAF-throttled). A programmatic jump's animation
  // frames are ignored for index tracking (they only advance scrollTop for the
  // viewport box); a real user gesture takes over immediately.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const st = c.scrollTop;
        setScrollTop(st); // viewport indicator follows even during the animation
        if (animatingRef.current) {
          // End the jump once we've arrived at the target; until then leave
          // currentIdx pinned to the jump target (set in goToChange).
          if (Math.abs(st - targetTopRef.current) <= 2) animatingRef.current = false;
          return;
        }
        setCurrentIdx(computeCurrentIdx(snapRef.current.startTops, st, SCROLL_MARGIN));
      });
    };
    // A user scroll gesture cancels the browser's smooth scroll, so stop treating
    // subsequent frames as programmatic and resume position-derived tracking.
    const onGesture = () => {
      animatingRef.current = false;
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    c.addEventListener('wheel', onGesture, { passive: true });
    c.addEventListener('touchstart', onGesture, { passive: true });
    c.addEventListener('pointerdown', onGesture);
    return () => {
      c.removeEventListener('scroll', onScroll);
      c.removeEventListener('wheel', onGesture);
      c.removeEventListener('touchstart', onGesture);
      c.removeEventListener('pointerdown', onGesture);
      cancelAnimationFrame(rafRef.current);
    };
    // Depends on `changes` so the listener (re)attaches once the scroll body
    // actually exists: on the first render the early-return branches (no file /
    // loading / empty file) render no `.diff-pane-body`, so containerRef.current
    // is null and the effect bails. When the file loads, `changes` changes and
    // this re-runs against the now-mounted body. Without this the viewport
    // indicator never tracks live scrolling (the remeasure path re-runs on
    // `changes` and so sizes ticks correctly, masking the missing listener).
  }, [containerRef, changes]);

  const total = changes.length;
  const hasOverflow = snap.scrollHeight > snap.clientHeight;

  const goToChange = useCallback(
    (i: number) => {
      const c = containerRef.current;
      if (!c || i < 0 || i >= total) return;
      // Set the index up front so the counter advances deterministically.
      setCurrentIdx(i);
      const top = scrollTargetFor(snapRef.current.startTops[i], c.scrollHeight, c.clientHeight);
      targetTopRef.current = top;
      animatingRef.current = true;
      window.clearTimeout(animCapRef.current);
      animCapRef.current = window.setTimeout(() => {
        animatingRef.current = false;
      }, ANIM_CAP_MS);
      scrollContainerTo(c, top);
    },
    [total, containerRef],
  );

  const goToNext = useCallback(() => goToChange(currentIdx + 1), [goToChange, currentIdx]);
  const goToPrev = useCallback(() => goToChange(currentIdx - 1), [goToChange, currentIdx]);

  const scrollToRatio = useCallback(
    (r: number) => {
      const c = containerRef.current;
      if (!c) return;
      // Rail scrub is a manual position change — let scroll-derived tracking run.
      animatingRef.current = false;
      c.scrollTo({ top: r * c.scrollHeight, behavior: 'auto' });
    },
    [containerRef],
  );

  const ticks = computeTicks(changes, snap.measured, snap.scrollHeight);
  const viewport = {
    topPct: snap.scrollHeight > 0 ? (scrollTop / snap.scrollHeight) * 100 : 0,
    heightPct: snap.scrollHeight > 0 ? (snap.clientHeight / snap.scrollHeight) * 100 : 100,
  };

  // Reset to the top only on a genuine view swap (file switch / whole-file
  // toggle), keyed on the stable `resetKey` rather than the `changes` array
  // reference. A same-file content recompute (new `changes` identity, same view)
  // no longer fires this — `currentIdx` is preserved and the `remeasure` path
  // re-derives it from the live scroll position (#577). -1 and 0 both display as
  // "1", so this never flickers the counter.
  useEffect(() => {
    animatingRef.current = false;
    setCurrentIdx(-1);
  }, [resetKey]);

  // Clear the safety-cap timer on unmount.
  useEffect(() => () => window.clearTimeout(animCapRef.current), []);

  return {
    total,
    currentIdx,
    canPrev: currentIdx > 0,
    canNext: currentIdx < total - 1,
    hasOverflow,
    ticks,
    viewport,
    scrollbarW: snap.scrollbarW,
    goToPrev,
    goToNext,
    goToChange,
    scrollToRatio,
    remeasure,
  };
}
