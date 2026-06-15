import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChangeNavigation } from './useChangeNavigation';
import type { DiffChange } from './diffChanges';

const CHANGES: DiffChange[] = [
  { kind: 'add', startRowIdx: 1, endRowIdx: 1, startLineNum: 10, addCount: 1, delCount: 0 },
  { kind: 'delete', startRowIdx: 5, endRowIdx: 5, startLineNum: 20, addCount: 0, delCount: 1 },
  { kind: 'modify', startRowIdx: 9, endRowIdx: 10, startLineNum: 30, addCount: 1, delCount: 1 },
];

// A fake scroll container: 1000px content, 200px viewport, change rows at 100/300/500.
function fakeContainer(scrollTop = 0): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 200, left: 0, right: 50, height: 200, width: 50 }) as DOMRect;
  const tops = [100, 300, 500];
  CHANGES.forEach((_change, i) => {
    const row = document.createElement('div');
    // Single-row fixtures tag start and end on the same element.
    row.setAttribute('data-change-start', String(i));
    row.setAttribute('data-change-end', String(i));
    const top = tops[i];
    row.getBoundingClientRect = () =>
      ({ top, bottom: top + 16, left: 0, right: 50, height: 16, width: 50 }) as DOMRect;
    el.appendChild(row);
  });
  el.scrollTo = vi.fn();
  return el;
}

describe('useChangeNavigation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('derives currentIdx -1 at the top and total/canPrev/canNext', () => {
    const container = fakeContainer(0);
    const ref = { current: container };
    const tableRef = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, tableRef, CHANGES));
    act(() => result.current.remeasure());
    expect(result.current.total).toBe(3);
    expect(result.current.currentIdx).toBe(-1);
    expect(result.current.canPrev).toBe(false);
    expect(result.current.canNext).toBe(true);
  });

  it('next() from -1 scrolls to the first change', () => {
    const container = fakeContainer(0);
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES));
    act(() => result.current.remeasure());
    act(() => result.current.goToNext());
    // first change row top is 100; scroll target = 100 - 8 margin = 92
    expect(container.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 92 }));
  });

  it('advances currentIdx to the jumped change deterministically', () => {
    // Regression (#486 review): the jump lands on the activation-margin boundary,
    // where re-deriving currentIdx from the settled scrollTop is fragile to
    // sub-pixel rounding. The pinned explicit index must reflect the target.
    const container = fakeContainer(0);
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES));
    act(() => result.current.remeasure());
    expect(result.current.currentIdx).toBe(-1);
    act(() => result.current.goToChange(1));
    expect(result.current.currentIdx).toBe(1);
    expect(result.current.canPrev).toBe(true);
    expect(result.current.canNext).toBe(true);
    act(() => result.current.goToNext());
    expect(result.current.currentIdx).toBe(2);
    expect(result.current.canNext).toBe(false);
  });

  it('attaches the scroll listener when the body mounts late (viewport tracks scroll)', () => {
    // Regression (#486 review): on DiffPane's first render the early-return
    // branches (no file / loading / empty) render no scroll container, so the
    // listener effect bails with a null ref. It must re-attach once the body
    // appears (a later render with a fresh `changes` ref), or the minimap
    // viewport indicator never moves on scroll. Simulate the late mount: start
    // with a null ref, then supply the container on a subsequent render.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const ref: { current: HTMLDivElement | null } = { current: null };
    const tableRef: { current: HTMLElement | null } = { current: null };
    let changes = CHANGES.slice();
    const { result, rerender } = renderHook(() => useChangeNavigation(ref, tableRef, changes));
    // Body mounts now; a new `changes` array ref drives the effect re-run.
    const container = fakeContainer(0);
    ref.current = container;
    tableRef.current = container;
    changes = CHANGES.slice();
    rerender();
    act(() => result.current.remeasure());
    expect(result.current.viewport.topPct).toBe(0);
    act(() => {
      container.scrollTop = 500; // half of the 1000px content
      container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.viewport.topPct).toBeGreaterThan(0);
    rafSpy.mockRestore();
  });

  it('produces ticks with kind + percentages', () => {
    const container = fakeContainer(0);
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES));
    act(() => result.current.remeasure());
    expect(result.current.ticks).toHaveLength(3);
    expect(result.current.ticks[0]).toMatchObject({ kind: 'add', topPct: 10 });
  });

  it('reports hasOverflow=false when content fits', () => {
    const container = fakeContainer(0);
    Object.defineProperty(container, 'scrollHeight', { value: 200, configurable: true });
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES));
    act(() => result.current.remeasure());
    expect(result.current.hasOverflow).toBe(false);
  });
});
