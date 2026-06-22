import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DiffChange, ChangeTick } from './diffChanges';
import { computeCurrentIdx, computeTicks } from './diffChanges';

const SCROLL_MARGIN = 8;
// Activation tolerance for deriving the current change from scroll position. MUST
// exceed SCROLL_MARGIN: goToChange snaps a change to exactly SCROLL_MARGIN below
// the top edge, landing it on the activation boundary, and the browser then settles
// scrollTop to a device-pixel integer slightly BELOW the fractional target. With
// the tolerance == SCROLL_MARGIN, computeCurrentIdx reads the snapped change as
// "not reached" (off-by-one low) and a parked remeasure clobbers the pinned index
// back to the previous change / -1 — the #577 double-click + counter desync. The
// +4px absorbs sub-pixel row offsets and integer scroll rounding while staying
// well under the minimum change spacing (~1 row), so the next change never
// activates early.
const ACTIVATION_MARGIN = SCROLL_MARGIN + 4;
// How far the scroll must move from a jump's target before the deterministic pin
// is released and position-derivation takes over. Larger than the arrival
// tolerance (2px) and sub-pixel/integer scroll rounding, smaller than any
// intentional scroll nudge (an arrow key scrolls tens of px). Lets changes
// clustered in the final unscrollable viewport — which all share the same clamped
// scroll position — stay individually addressable by the prev/next pin (#577).
const PIN_RELEASE_PX = 8;
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
  // scrollTop rounds relative to the activation margin, and able to address
  // changes in the final unscrollable viewport that position can't distinguish);
  // a genuine MANUAL scroll recomputes it from position. The two are reconciled
  // by `animatingRef` (in flight) and `pinnedIdxRef` (parked at a jump target).
  const [currentIdx, setCurrentIdx] = useState(-1);
  // True while a programmatic scroll-to is in flight. Cleared on arrival at the
  // target, on a user scroll gesture (wheel/touch/pointer), or by the safety cap
  // — so trailing animation-frame scroll events never overwrite currentIdx.
  const animatingRef = useRef(false);
  const targetTopRef = useRef(0);
  // The change index the last jump deterministically pinned, held until the user
  // scrolls away from its target (PIN_RELEASE_PX). While pinned, position-derived
  // recomputes (parked remeasure / scroll handler) yield to it instead of
  // downgrading the counter — the fix for changes clustered in the final
  // unscrollable viewport, whose shared clamped scroll position can't tell them
  // apart, and for a parked remeasure landing on the activation boundary (#577).
  // -1 = no active pin (manual scrolling drives the counter).
  const pinnedIdxRef = useRef(-1);
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

  // Position-derived current index, except the last jump's PIN wins while the
  // scroll is still parked at that jump's target. Changes clustered in the final
  // (unscrollable) viewport share one clamped scroll position, so deriving from
  // position alone would downgrade the counter and a parked remeasure would wipe
  // the pin. Once the scroll moves past PIN_RELEASE_PX from the target the pin is
  // released and position drives again — covering keyboard scroll, which fires
  // 'scroll' but no wheel/pointer gesture. (#577)
  const derivePinAware = useCallback((startTops: number[], st: number): number => {
    const pin = pinnedIdxRef.current;
    if (pin >= 0 && Math.abs(st - targetTopRef.current) <= PIN_RELEASE_PX) {
      return Math.min(pin, startTops.length - 1); // clamp into bounds (shrink-safe)
    }
    pinnedIdxRef.current = -1;
    return computeCurrentIdx(startTops, st, ACTIVATION_MARGIN);
  }, []);

  const remeasure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const m = measure(c, changes);
    setSnap(m);
    setScrollTop(c.scrollTop);
    // Keep currentIdx consistent with the new geometry while parked (not mid-jump).
    // A still-active pin (jump target not yet scrolled away from) wins over
    // position so a parked remeasure can't wipe it.
    if (!animatingRef.current) {
      setCurrentIdx(derivePinAware(m.startTops, c.scrollTop));
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
    pinnedIdxRef.current = i; // keep the pin clamped in step with the jump
    if (i < 0) {
      // The change set emptied mid-jump (nothing to arrive at): clear the
      // animating flag now so scroll-derived tracking resumes immediately
      // instead of waiting out ANIM_CAP_MS.
      animatingRef.current = false;
      return;
    }
    const top = scrollTargetFor(m.startTops[i], m.scrollHeight, m.clientHeight);
    if (Math.abs(top - targetTopRef.current) > 2) {
      targetTopRef.current = top;
      scrollContainerTo(c, top);
    }
  }, [containerRef, changes, derivePinAware]);

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
        setCurrentIdx(derivePinAware(snapRef.current.startTops, st));
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
  }, [containerRef, changes, derivePinAware]);

  const total = changes.length;
  const hasOverflow = snap.scrollHeight > snap.clientHeight;

  const goToChange = useCallback(
    (i: number) => {
      const c = containerRef.current;
      if (!c || i < 0 || i >= total) return;
      // Set the index up front so the counter advances deterministically, and pin
      // it so a parked remeasure / clamped-scroll derive can't downgrade it.
      setCurrentIdx(i);
      pinnedIdxRef.current = i;
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
      // Rail scrub is a manual position change — release the pin and let
      // scroll-derived tracking run.
      animatingRef.current = false;
      pinnedIdxRef.current = -1;
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
  // re-derives it from the live scroll position (#577). The new view opens above
  // its first change (currentIdx -1 → "— / M").
  useEffect(() => {
    animatingRef.current = false;
    pinnedIdxRef.current = -1;
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
