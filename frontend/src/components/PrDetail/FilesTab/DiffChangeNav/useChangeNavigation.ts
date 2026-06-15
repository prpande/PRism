import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DiffChange, ChangeTick } from './diffChanges';
import { computeCurrentIdx, computeTicks } from './diffChanges';

const SCROLL_MARGIN = 8;
const SETTLE_CAP_MS = 400;

export interface ChangeNavState {
  total: number;
  currentIdx: number; // -1..total-1
  canPrev: boolean;
  canNext: boolean;
  hasOverflow: boolean;
  ticks: ChangeTick[];
  viewport: { topPct: number; heightPct: number };
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
  };
}

export function useChangeNavigation(
  containerRef: RefObject<HTMLElement | null>,
  tableRef: RefObject<HTMLElement | null>,
  changes: DiffChange[],
): ChangeNavState {
  const [snap, setSnap] = useState<Measured>({
    startTops: [],
    measured: [],
    scrollHeight: 0,
    clientHeight: 0,
  });
  const [scrollTop, setScrollTop] = useState(0);
  const suppressRef = useRef(false);
  const rafRef = useRef(0);

  const remeasure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    setSnap(measure(c, changes));
    setScrollTop(c.scrollTop);
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

  // Scroll tracking (rAF-throttled), suppressed during programmatic scroll-to.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onScroll = () => {
      if (suppressRef.current) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => setScrollTop(c.scrollTop));
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      c.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef]);

  const currentIdx = computeCurrentIdx(snap.startTops, scrollTop, SCROLL_MARGIN);
  const total = changes.length;
  const hasOverflow = snap.scrollHeight > snap.clientHeight;

  const scrollToTop = useCallback(
    (top: number, targetIdx: number) => {
      const c = containerRef.current;
      if (!c) return;
      // Set state immediately + suppress scroll-driven recompute until settle.
      suppressRef.current = true;
      setScrollTop(top);
      const clear = () => {
        suppressRef.current = false;
        setScrollTop(c.scrollTop);
        cleanup();
      };
      const onInterrupt = () => clear();
      const cap = window.setTimeout(clear, SETTLE_CAP_MS);
      const cleanup = () => {
        window.clearTimeout(cap);
        c.removeEventListener('scrollend', clear);
        window.removeEventListener('wheel', onInterrupt, true);
        window.removeEventListener('keydown', onInterrupt, true);
        window.removeEventListener('pointerdown', onInterrupt, true);
      };
      c.addEventListener('scrollend', clear, { once: true });
      window.addEventListener('wheel', onInterrupt, { capture: true, once: true });
      window.addEventListener('keydown', onInterrupt, { capture: true, once: true });
      window.addEventListener('pointerdown', onInterrupt, { capture: true, once: true });
      void targetIdx;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      c.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
    },
    [containerRef],
  );

  const goToChange = useCallback(
    (i: number) => {
      if (i < 0 || i >= total) return;
      const top = Math.max(0, snap.startTops[i] - SCROLL_MARGIN);
      scrollToTop(top, i);
    },
    [total, snap.startTops, scrollToTop],
  );

  const goToNext = useCallback(() => goToChange(currentIdx + 1), [goToChange, currentIdx]);
  const goToPrev = useCallback(() => goToChange(currentIdx - 1), [goToChange, currentIdx]);

  const scrollToRatio = useCallback(
    (r: number) => {
      const c = containerRef.current;
      if (!c) return;
      c.scrollTo({ top: r * c.scrollHeight, behavior: 'auto' });
    },
    [containerRef],
  );

  const ticks = computeTicks(changes, snap.measured, snap.scrollHeight);
  const viewport = {
    topPct: snap.scrollHeight > 0 ? (scrollTop / snap.scrollHeight) * 100 : 0,
    heightPct: snap.scrollHeight > 0 ? (snap.clientHeight / snap.scrollHeight) * 100 : 100,
  };

  // Clear suppression if the change list swaps (file switch / whole-file toggle).
  useEffect(() => {
    suppressRef.current = false;
  }, [changes]);

  return {
    total,
    currentIdx,
    canPrev: currentIdx > 0,
    canNext: currentIdx < total - 1,
    hasOverflow,
    ticks,
    viewport,
    goToPrev,
    goToNext,
    goToChange,
    scrollToRatio,
    remeasure,
  };
}
