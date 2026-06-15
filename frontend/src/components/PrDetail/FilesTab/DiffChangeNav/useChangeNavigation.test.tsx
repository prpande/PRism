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
  CHANGES.forEach((c, i) => {
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
