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

// A scroll container whose change rows reposition with scrollTop (unlike the
// fixed-position fakeContainer), and whose scrollTo FLOORS the target to an
// integer — mimicking the browser settling a programmatic smooth scroll on the
// device-pixel grid a sub-pixel BELOW a fractional target. This reproduces the
// activation-margin boundary the #577 double-click bug lives on.
function scrollContainerWithTops(
  absTops: number[],
  opts: { scrollHeight?: number; clientHeight?: number } = {},
): HTMLDivElement {
  const el = document.createElement('div');
  let st = 0;
  Object.defineProperty(el, 'scrollHeight', {
    value: opts.scrollHeight ?? 6000,
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    value: opts.clientHeight ?? 600,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => st,
    set: (v: number) => {
      st = v;
    },
    configurable: true,
  });
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 600, left: 0, right: 50, height: 600, width: 50 }) as DOMRect;
  absTops.forEach((top, i) => {
    const row = document.createElement('div');
    row.setAttribute('data-change-start', String(i));
    row.setAttribute('data-change-end', String(i));
    row.getBoundingClientRect = () => {
      const t = top - el.scrollTop; // viewport-relative; moves with scroll
      return { top: t, bottom: t + 16, left: 0, right: 50, height: 16, width: 50 } as DOMRect;
    };
    el.appendChild(row);
  });
  el.scrollTo = vi.fn((opts?: ScrollToOptions) => {
    el.scrollTop = Math.floor(opts?.top ?? 0); // browser snaps below the fractional target
  }) as unknown as typeof el.scrollTo;
  return el;
}

// N trivial changes whose fields don't affect index tracking (the hook keys off
// changes.length + the DOM data-change-start rows, not these values).
const makeChanges = (n: number): DiffChange[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'add' as const,
    startRowIdx: i,
    endRowIdx: i,
    startLineNum: (i + 1) * 10,
    addCount: 1,
    delCount: 0,
  }));

describe('useChangeNavigation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('derives currentIdx -1 at the top and total/canPrev/canNext', () => {
    const container = fakeContainer(0);
    const ref = { current: container };
    const tableRef = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, tableRef, CHANGES, 'k'));
    act(() => result.current.remeasure());
    expect(result.current.total).toBe(3);
    expect(result.current.currentIdx).toBe(-1);
    expect(result.current.canPrev).toBe(false);
    expect(result.current.canNext).toBe(true);
  });

  it('next() from -1 scrolls to the first change', () => {
    const container = fakeContainer(0);
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES, 'k'));
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
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES, 'k'));
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
    const { result, rerender } = renderHook(() => useChangeNavigation(ref, tableRef, changes, 'k'));
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

  it('preserves currentIdx when changes recomputes for the same view (#577)', () => {
    // #577 repro: with the SAME file open, an unrelated content recompute hands
    // the hook a NEW `changes` array (same content, same view identity) — e.g. a
    // parent `files` re-fetch or whole-file async load. The counter must NOT snap
    // back to "1", and an in-flight advance must survive. The reset is keyed on
    // the stable view identity (4th arg), not the memoized array reference.
    const container = fakeContainer(0);
    const ref = { current: container };
    let changes = CHANGES.slice();
    const viewKey = 'src/main.ts false';
    const { result, rerender } = renderHook(() => useChangeNavigation(ref, ref, changes, viewKey));
    act(() => result.current.remeasure());
    act(() => result.current.goToChange(1));
    expect(result.current.currentIdx).toBe(1);
    // Settle the smooth-scroll at the jump target so position-derived tracking is
    // authoritative (change 1's row top is 300, target = 300 - 8 margin = 292).
    act(() => {
      container.scrollTop = 292;
      container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.currentIdx).toBe(1);

    // Same view, content recompute → NEW array identity, SAME content + viewKey.
    changes = CHANGES.slice();
    rerender();
    // Pre-fix (reset keyed on `changes`): currentIdx is wiped to -1 → "1".
    expect(result.current.currentIdx).toBe(1);
    // And a single Next still advances exactly one change (not a wasted click).
    act(() => result.current.goToNext());
    expect(result.current.currentIdx).toBe(2);
  });

  it('resets currentIdx to the top when the view identity changes (file switch) (#577)', () => {
    // The reset must still fire on a genuine view swap (different file / whole-file
    // toggle), so a fresh file always opens at the top rather than inheriting the
    // previous file's index.
    const container = fakeContainer(0);
    const ref = { current: container };
    let changes = CHANGES.slice();
    let viewKey = 'a.ts false';
    const { result, rerender } = renderHook(() => useChangeNavigation(ref, ref, changes, viewKey));
    act(() => result.current.remeasure());
    act(() => result.current.goToChange(2));
    expect(result.current.currentIdx).toBe(2);

    // Switch files: new view identity + new change list.
    changes = CHANGES.slice();
    viewKey = 'b.ts false';
    rerender();
    expect(result.current.currentIdx).toBe(-1);
  });

  it('re-aims an in-flight jump at the moved target on a same-view recompute (#577 secondary)', () => {
    // Secondary suspect: if content height shifts DURING a smooth scroll, the
    // captured target goes stale and the jump never "arrives", wedging the
    // animating flag until the 1200ms cap. remeasure re-aims at the target row's
    // new top so the jump settles normally instead.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const container = fakeContainer(0);
    const ref = { current: container };
    const changes = CHANGES.slice();
    const { result } = renderHook(() =>
      useChangeNavigation(ref, ref, changes, 'src/main.ts false'),
    );
    act(() => result.current.remeasure());
    // Jump to change 1 (row top 300 → target 292); animation is in flight.
    act(() => result.current.goToChange(1));
    expect(container.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 292 }));
    // Content above change 1 grows, pushing its row down 300 → 360 (kept ascending
    // so computeCurrentIdx's monotonic invariant holds).
    const row1 = container.querySelector('[data-change-start="1"]') as HTMLElement;
    row1.getBoundingClientRect = () =>
      ({ top: 360, bottom: 376, left: 0, right: 50, height: 16, width: 50 }) as DOMRect;
    // Same-view recompute mid-jump → re-aim at the new top (360 - 8 = 352).
    act(() => result.current.remeasure());
    expect(container.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 352 }));
    // Arrival at the corrected target clears the animation; manual scroll resumes.
    act(() => {
      container.scrollTop = 352;
      container.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.currentIdx).toBe(-1);
    rafSpy.mockRestore();
  });

  it('clamps a pinned index into bounds when a same-view recompute shrinks the set (#577)', () => {
    // After the fix the index is preserved across same-view recomputes; if the
    // recompute SHRINKS the change set while a jump is pinned, the counter must
    // never read "N of M" with N > M — clamp to total-1.
    const container = fakeContainer(0);
    const ref = { current: container };
    let changes = CHANGES.slice();
    const { result, rerender } = renderHook(() =>
      useChangeNavigation(ref, ref, changes, 'src/main.ts false'),
    );
    act(() => result.current.remeasure());
    act(() => result.current.goToChange(2));
    expect(result.current.currentIdx).toBe(2);
    expect(result.current.total).toBe(3);
    // Same view, change set drops to 2 (e.g. head advanced / re-fetch).
    changes = CHANGES.slice(0, 2);
    rerender();
    expect(result.current.total).toBe(2);
    expect(result.current.currentIdx).toBe(1); // clamped, not a stale 2 → "3 of 2"
    expect(result.current.canNext).toBe(false);
  });

  it('keeps a snapped change current when scroll settles a sub-pixel below the target (#577)', () => {
    // The double-click / counter-desync mechanism: goToChange snaps a change to
    // exactly SCROLL_MARGIN (8px) below the top edge, landing it on the activation
    // boundary. The browser settles scrollTop to an integer JUST UNDER the
    // fractional target, so with the activation margin == the snap offset,
    // computeCurrentIdx reads the change as "not reached" and a parked remeasure
    // (content settling: syntax highlight / whole-file / AI) clobbers the pinned
    // index back to -1. The next click then re-navigates to the SAME change
    // (view doesn't move) — the user must click twice. A wider activation
    // tolerance keeps the snapped change current.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    // Change 0 at a fractional offset: snap target 201.40625 - 8 = 193.40625,
    // floored by the browser to the integer 193.
    const c = scrollContainerWithTops([201.40625, 1772.375]);
    const ref = { current: c };
    const changes = CHANGES.slice(0, 2); // stable identity across renders
    const { result } = renderHook(() =>
      useChangeNavigation(ref, ref, changes, 'src/main.ts false'),
    );
    act(() => result.current.remeasure());
    act(() => result.current.goToChange(0));
    expect(result.current.currentIdx).toBe(0);
    // Browser settles the smooth scroll at the floored integer; arrival clears the
    // animating flag, so we're now "parked" on change 0.
    act(() => c.dispatchEvent(new Event('scroll')));
    // Content settles slightly later → a parked remeasure fires. Pre-fix this
    // re-derived currentIdx = -1 from the boundary scroll position and wiped the pin.
    act(() => result.current.remeasure());
    expect(result.current.currentIdx).toBe(0);
    rafSpy.mockRestore();
  });

  it('keeps the pinned change current when the jump target clamps at the bottom (#577)', () => {
    // Changes clustered in the final viewport all clamp to the same maxTop scroll
    // position, so computeCurrentIdx cannot tell them apart — the last few are
    // unreachable by scroll. The deterministic pin from goToChange must win, or
    // the counter sticks below them and "Next" appears to do nothing.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    // scrollHeight 1000, clientHeight 600 → maxTop 400. Changes 1..3 sit BELOW
    // maxTop + margin, so position can only ever derive change 0.
    const c = scrollContainerWithTops([100, 850, 900, 950], {
      scrollHeight: 1000,
      clientHeight: 600,
    });
    const ref = { current: c };
    const changes = makeChanges(4);
    const { result } = renderHook(() => useChangeNavigation(ref, ref, changes, 'k'));
    act(() => result.current.remeasure());
    act(() => result.current.goToChange(3)); // target 950-8=942 clamps to maxTop 400
    expect(result.current.currentIdx).toBe(3);
    // Arrival at the clamped target clears the animating flag → now parked.
    act(() => c.dispatchEvent(new Event('scroll')));
    // A parked remeasure (content settling) must NOT downgrade the pinned index to
    // the only position-reachable change (0).
    act(() => result.current.remeasure());
    expect(result.current.currentIdx).toBe(3);
    rafSpy.mockRestore();
  });

  it('releases the pin and tracks position once the user scrolls away (#577)', () => {
    // The pin is authoritative only while parked at the jump target. A genuine
    // scroll away (here back to the top — also what a keyboard PageUp produces,
    // firing 'scroll' but no wheel/pointer gesture) releases it so the counter
    // tracks position again.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const c = scrollContainerWithTops([201.40625, 1772.375]);
    const ref = { current: c };
    const changes = makeChanges(2);
    const { result } = renderHook(() => useChangeNavigation(ref, ref, changes, 'k'));
    act(() => result.current.remeasure());
    act(() => result.current.goToChange(0));
    act(() => c.dispatchEvent(new Event('scroll'))); // arrival → parked, pinned at 0
    expect(result.current.currentIdx).toBe(0);
    // User scrolls back to the very top, far from the target → pin released.
    act(() => {
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.currentIdx).toBe(-1);
    rafSpy.mockRestore();
  });

  it('produces ticks with kind + percentages', () => {
    const container = fakeContainer(0);
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES, 'k'));
    act(() => result.current.remeasure());
    expect(result.current.ticks).toHaveLength(3);
    expect(result.current.ticks[0]).toMatchObject({ kind: 'add', topPct: 10 });
  });

  it('reports hasOverflow=false when content fits', () => {
    const container = fakeContainer(0);
    Object.defineProperty(container, 'scrollHeight', { value: 200, configurable: true });
    const ref = { current: container };
    const { result } = renderHook(() => useChangeNavigation(ref, ref, CHANGES, 'k'));
    act(() => result.current.remeasure());
    expect(result.current.hasOverflow).toBe(false);
  });
});
