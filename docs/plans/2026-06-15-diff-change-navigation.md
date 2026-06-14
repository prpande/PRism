# Diff change-navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scroll-track change minimap (whole-file mode) and prev/next-change controls (both modes) to the Files-tab diff, so reviewers can see and walk every change.

**Architecture:** One pure change model (`computeChanges` over the existing `allLines: DiffLine[]`) feeds two surfaces — a thin overlay rail (`ChangeMinimap`, whole-file only) and a header cluster (`ChangeNavControls`, both modes) — coordinated by a `useChangeNavigation` hook that measures row offsets and tracks the current change. New units live in a `DiffChangeNav/` subdirectory; `DiffPane.tsx` wires them in.

**Tech Stack:** React + TypeScript + Vite, CSS modules + global design tokens (`tokens.css`), Vitest + @testing-library/react + user-event, Playwright (visual baselines).

**Spec:** `docs/specs/2026-06-15-diff-change-navigation-design.md`. **Issue:** #486 (T3, gated B1). **Follow-up:** #493 (AI markers — out of scope here).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.ts` | Pure change model: `DiffChange` type, `computeChanges`, `computeCurrentIdx`, `computeTicks` | 1 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.test.ts` | Unit tests for the pure model | 1 |
| `frontend/src/hooks/isInputTarget.ts` | Shared keyboard input-guard helper (extracted) | 2 |
| `frontend/src/hooks/useFilesTabShortcuts.ts` | Modified: import the shared guard | 2 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.ts` | Hook: measure offsets, currentIdx, prev/next, ticks, viewport, observers, scroll-suppress | 3 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.test.tsx` | Hook tests (injected offsets + jsdom path) | 3 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.tsx` | Header cluster (git-compare icon + chevrons + counter + live region; icons are module-private fns, matching `ReviewActionButton`'s inline `Chevron`) | 4 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.module.css` | Cluster styles | 4 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.test.tsx` | Controls tests | 4 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.tsx` | Rail: ticks, viewport box, hover-expand, tooltip, click handlers | 5 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.module.css` | Rail styles (rest/hover, pointer:coarse, both themes) | 5 |
| `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.test.tsx` | Rail tests | 5 |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` | Wire wrapper + table ref + tagging + hook + render + n/p listener | 6 |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (inline `DiffLineRow` ~:713 / `SplitDiffLineRow` ~:853 components) | Forward `data-change-start` + `data-change-end` onto their `<tr>` | 6 |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` | `.diffBodyWrap` + `scrollbar-gutter` | 6 |
| `frontend/src/components/Cheatsheet/shortcuts.ts` | Add `n`/`p` to "Diff" group | 7 |
| `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx` | Add `n`/`p` to the hint | 7 |
| `frontend/e2e/...` visual baselines | B1 visual gate | 8 |

**Convention note:** This codebase tests with Vitest (`describe`/`it`/`expect`/`vi` from `vitest`), `render`/`renderHook` from `@testing-library/react`, default-import `userEvent` from `@testing-library/user-event`. Run a single test file with the local binary (NOT `npx vitest`): `cd frontend && node_modules/.bin/vitest run <path>`.

---

## Task 1: Pure change model (`diffChanges.ts`)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.ts`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// diffChanges.test.ts
import { describe, it, expect } from 'vitest';
import type { DiffLine } from '../../../../api/types';
import { computeChanges, computeCurrentIdx, computeTicks } from './diffChanges';

function ctx(n: number): DiffLine {
  return { type: 'context', content: 'c', oldLineNum: n, newLineNum: n };
}
function ins(n: number): DiffLine {
  return { type: 'insert', content: '+', oldLineNum: null, newLineNum: n };
}
function del(n: number): DiffLine {
  return { type: 'delete', content: '-', oldLineNum: n, newLineNum: null };
}
const hdr: DiffLine = { type: 'hunk-header', content: '@@', oldLineNum: null, newLineNum: null };

describe('computeChanges', () => {
  it('returns empty for no changed lines', () => {
    expect(computeChanges([ctx(1), ctx(2)])).toEqual([]);
  });

  it('classifies a pure-insert run as add', () => {
    const out = computeChanges([ctx(1), ins(2), ins(3), ctx(4)]);
    expect(out).toEqual([
      { kind: 'add', startRowIdx: 1, endRowIdx: 2, startLineNum: 2, addCount: 2, delCount: 0 },
    ]);
  });

  it('classifies a pure-delete run as delete with old line number', () => {
    const out = computeChanges([ctx(1), del(5), ctx(2)]);
    expect(out[0]).toMatchObject({ kind: 'delete', startLineNum: 5, addCount: 0, delCount: 1 });
  });

  it('classifies a delete-then-insert block as a single modify', () => {
    const out = computeChanges([del(5), del(6), ins(5), ins(6)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'modify', startRowIdx: 0, endRowIdx: 3, startLineNum: 5 });
  });

  it('splits runs on context, hunk-header, and filled rows', () => {
    const filled: DiffLine = { type: 'context', content: 'x', oldLineNum: 9, newLineNum: 9, isFilled: true };
    const out = computeChanges([ins(1), ctx(2), del(3), hdr, ins(4), filled, del(5)]);
    expect(out.map((c) => c.kind)).toEqual(['add', 'delete', 'add', 'delete']);
  });
});

describe('computeCurrentIdx', () => {
  const tops = [100, 300, 500]; // start offsets of 3 changes
  it('is -1 above the first change', () => {
    expect(computeCurrentIdx(tops, 0)).toBe(-1);
    expect(computeCurrentIdx(tops, 80)).toBe(-1); // 80 + 8 < 100
  });
  it('selects the most recently passed change', () => {
    expect(computeCurrentIdx(tops, 100)).toBe(0); // 100 + 8 >= 100
    expect(computeCurrentIdx(tops, 350)).toBe(1);
    expect(computeCurrentIdx(tops, 9999)).toBe(2);
  });
});

describe('computeTicks', () => {
  it('maps measurements to percentages with a 3px floor', () => {
    const changes = computeChanges([ins(1)]); // 1 add, rowCount 1
    const ticks = computeTicks(changes, [{ top: 50, heightPx: 1 }], 1000);
    expect(ticks[0]).toMatchObject({ kind: 'add', topPct: 5 });
    expect(ticks[0].heightPct).toBeCloseTo(0.3); // max(3,1)=3 -> 0.3%
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.test.ts`
Expected: FAIL — `computeChanges` (and siblings) not exported / module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// diffChanges.ts
import type { DiffLine } from '../../../../api/types';

export interface DiffChange {
  kind: 'add' | 'delete' | 'modify';
  startRowIdx: number; // index into allLines of the run's first changed row
  endRowIdx: number; // inclusive
  startLineNum: number; // new-side line of the first row; old-side if pure delete
  addCount: number;
  delCount: number;
}

function isChanged(line: DiffLine): boolean {
  // Filled context (whole-file gap fill) and real context/hunk-header break runs.
  return (line.type === 'insert' || line.type === 'delete') && line.isFilled !== true;
}

/** Contiguous runs of insert/delete rows. Mixed runs are `modify`. Pure functions only. */
export function computeChanges(lines: DiffLine[]): DiffChange[] {
  const out: DiffChange[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isChanged(lines[i])) {
      i += 1;
      continue;
    }
    const startRowIdx = i;
    let addCount = 0;
    let delCount = 0;
    let startLineNum = 0;
    while (i < lines.length && isChanged(lines[i])) {
      const l = lines[i];
      if (l.type === 'insert') addCount += 1;
      else delCount += 1;
      if (startLineNum === 0) startLineNum = (l.newLineNum ?? l.oldLineNum) ?? 0;
      i += 1;
    }
    const endRowIdx = i - 1;
    const kind = addCount > 0 && delCount > 0 ? 'modify' : addCount > 0 ? 'add' : 'delete';
    out.push({ kind, startRowIdx, endRowIdx, startLineNum, addCount, delCount });
  }
  return out;
}

/** Index of the last change whose start offset is at/below scrollTop+margin; -1 above the first. */
export function computeCurrentIdx(startTops: number[], scrollTop: number, margin = 8): number {
  let idx = -1;
  for (let i = 0; i < startTops.length; i++) {
    if (startTops[i] <= scrollTop + margin) idx = i;
    else break;
  }
  return idx;
}

export interface ChangeTick {
  kind: DiffChange['kind'];
  topPct: number;
  heightPct: number;
  startLineNum: number;
  addCount: number;
  delCount: number;
}

/** Map measured pixel offsets to rail percentages. Min tick height 3px. */
export function computeTicks(
  changes: DiffChange[],
  measured: ReadonlyArray<{ top: number; heightPx: number }>,
  scrollHeight: number,
): ChangeTick[] {
  if (scrollHeight <= 0) return [];
  return changes.map((c, i) => {
    const m = measured[i] ?? { top: 0, heightPx: 0 };
    const heightPx = Math.max(3, m.heightPx);
    return {
      kind: c.kind,
      topPct: (m.top / scrollHeight) * 100,
      heightPct: (heightPx / scrollHeight) * 100,
      startLineNum: c.startLineNum,
      addCount: c.addCount,
      delCount: c.delCount,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.ts frontend/src/components/PrDetail/FilesTab/DiffChangeNav/diffChanges.test.ts
git commit -m "feat(diff): pure change model for change-navigation (#486)"
```

---

## Task 2: Extract the shared `isInputTarget` guard

**Why:** the new `n`/`p` listener (Task 6) must reuse the exact input-guard (including the `.diff-view-toggle` radio carve-out) that `useFilesTabShortcuts` uses; it is currently module-private. Extract it so both single-source it.

**Files:**
- Create: `frontend/src/hooks/isInputTarget.ts`
- Create: `frontend/src/hooks/isInputTarget.test.ts`
- Modify: `frontend/src/hooks/useFilesTabShortcuts.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// isInputTarget.test.ts
import { describe, it, expect } from 'vitest';
import { isInputTarget } from './isInputTarget';

describe('isInputTarget', () => {
  it('returns false for non-elements', () => {
    expect(isInputTarget(null)).toBe(false);
  });
  it('suppresses inside a textarea/input/select', () => {
    const ta = document.createElement('textarea');
    expect(isInputTarget(ta)).toBe(true);
  });
  it('lets through radios inside .diff-view-toggle', () => {
    const group = document.createElement('div');
    group.className = 'diff-view-toggle';
    const radio = document.createElement('input');
    radio.type = 'radio';
    group.appendChild(radio);
    expect(isInputTarget(radio)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/isInputTarget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared helper (verbatim move from `useFilesTabShortcuts.ts`)**

```typescript
// isInputTarget.ts
const INPUT_TAG_NAMES = new Set(['TEXTAREA', 'INPUT', 'SELECT']);

/** True when a naked-key shortcut should be suppressed for this event target. */
export function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // ONLY the inline diff-view tiles (radios inside the .diff-view-toggle group)
  // may let the single-key Files-tab shortcuts through. Scoped to that specific
  // class — not any [role="radiogroup"] — so a future radiogroup elsewhere on the
  // page cannot inadvertently leak shortcuts. Everything else — text fields AND the
  // gear's checkboxes — still suppresses.
  if (
    target.tagName === 'INPUT' &&
    (target as HTMLInputElement).type === 'radio' &&
    target.closest('.diff-view-toggle')
  ) {
    return false;
  }
  if (INPUT_TAG_NAMES.has(target.tagName)) return true;
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}
```

- [ ] **Step 4: Update `useFilesTabShortcuts.ts` to import the shared guard**

Replace the top of the file (the `INPUT_TAG_NAMES` const and the local `isInputTarget` function, lines ~10–34) with an import, leaving the rest unchanged:

```typescript
import { useEffect, useRef } from 'react';
import { isInputTarget } from './isInputTarget';

export interface FilesTabShortcutHandlers {
  onNextFile: () => void;
  onPrevFile: () => void;
  onToggleViewed: () => void;
  onToggleDiffMode: () => void;
}

// (local INPUT_TAG_NAMES + isInputTarget removed — now imported above)

export function useFilesTabShortcuts(handlers: FilesTabShortcutHandlers): void {
  // ...unchanged body...
}
```

- [ ] **Step 5: Run both the new test and the existing shortcuts test**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/isInputTarget.test.ts src/hooks/useFilesTabShortcuts.test.tsx`
Expected: PASS (the existing shortcut tests still pass — behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/isInputTarget.ts frontend/src/hooks/isInputTarget.test.ts frontend/src/hooks/useFilesTabShortcuts.ts
git commit -m "refactor(diff): extract shared isInputTarget keyboard guard (#486)"
```

---

## Task 3: `useChangeNavigation` hook

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.ts`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.test.tsx`

The hook composes the pure helpers from Task 1 with DOM measurement. It is jsdom-resilient: `ResizeObserver` and `scrollend` are feature-detected; the unit test drives the deps-array re-measure path and asserts the derived state.

- [ ] **Step 1: Write the failing test**

```typescript
// useChangeNavigation.test.tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.test.tsx`
Expected: FAIL — hook not found.

- [ ] **Step 3: Write the hook**

```typescript
// useChangeNavigation.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.test.tsx`
Expected: PASS. (jsdom has no `ResizeObserver`/`scrollend`; the test drives `remeasure()` directly and `scrollTo` is a stub — the math is what's asserted.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.ts frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.test.tsx
git commit -m "feat(diff): useChangeNavigation hook (measure, currentIdx, prev/next) (#486)"
```

---

## Task 4: `ChangeNavControls` (header cluster) + icon

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.tsx` (the git-compare lead icon is a module-private function here — single consumer, mirrors the inline `ChevronUp`/`ChevronDown` in the same file and `ReviewActionButton`'s inline `Chevron`; promote to `diffIcons.tsx` only if #493 needs it)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// ChangeNavControls.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeNavControls } from './ChangeNavControls';

const base = { total: 7, currentIdx: 2, canPrev: true, canNext: true, onPrev: () => {}, onNext: () => {} };

describe('ChangeNavControls', () => {
  it('shows the 1-based counter N / M', () => {
    const { getByText } = render(<ChangeNavControls {...base} />);
    expect(getByText('3 / 7')).toBeInTheDocument();
  });

  it('shows — / M above the first change', () => {
    const { getByText } = render(<ChangeNavControls {...base} currentIdx={-1} canPrev={false} />);
    expect(getByText('— / 7')).toBeInTheDocument();
  });

  it('disables prev at the first change and next at the last', () => {
    const { getByRole, rerender } = render(
      <ChangeNavControls {...base} currentIdx={0} canPrev={false} />,
    );
    expect((getByRole('button', { name: /previous change/i }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ChangeNavControls {...base} currentIdx={6} canNext={false} />);
    expect((getByRole('button', { name: /next change/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onNext / onPrev', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { getByRole } = render(<ChangeNavControls {...base} onNext={onNext} onPrev={onPrev} />);
    await userEvent.click(getByRole('button', { name: /next change/i }));
    await userEvent.click(getByRole('button', { name: /previous change/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('announces the position in a status live region', () => {
    const { getByRole } = render(<ChangeNavControls {...base} />);
    expect(getByRole('status')).toHaveTextContent('change 3 of 7');
  });

  it('announces the at-top state when above the first change', () => {
    const { getByRole } = render(<ChangeNavControls {...base} currentIdx={-1} canPrev={false} />);
    expect(getByRole('status')).toHaveTextContent('at top, 7 changes');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the icon (a module-private function — it lives at the top of `ChangeNavControls.tsx`, see Step 4; no separate file)**

```tsx
// git-compare glyph in the diffIcons house style (16x16, currentColor) — private to ChangeNavControls.tsx
function ChangeNavIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="4" cy="4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4 5.7v3.1a2 2 0 0 0 2 2h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 10.3V7.2a2 2 0 0 0-2-2H6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Write the component**

```tsx
// ChangeNavControls.tsx
import styles from './ChangeNavControls.module.css';
// ChangeNavIcon (from Step 3), ChevronUp, ChevronDown are all module-private functions in this file.

export interface ChangeNavControlsProps {
  total: number;
  currentIdx: number; // -1..total-1
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

function ChevronUp() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChangeNavControls({ total, currentIdx, canPrev, canNext, onPrev, onNext }: ChangeNavControlsProps) {
  const display = currentIdx < 0 ? '—' : String(currentIdx + 1);
  const announce = currentIdx < 0 ? `at top, ${total} changes` : `change ${currentIdx + 1} of ${total}`;
  return (
    <div className={styles.cluster} role="group" aria-label="Change navigation">
      <span className={styles.lead} aria-hidden>
        <ChangeNavIcon />
      </span>
      <button type="button" className={styles.chev} aria-label="Previous change" disabled={!canPrev} onClick={onPrev}>
        <ChevronUp />
      </button>
      <span className={styles.count}>
        {display} / {total}
      </span>
      <button type="button" className={styles.chev} aria-label="Next change" disabled={!canNext} onClick={onNext}>
        <ChevronDown />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
```

> Note: the live region reads from `currentIdx` (props), so it re-renders with new text on every move — button, key, or tick-click (which all update the shared hook state). No per-source trigger.

- [ ] **Step 5: Write the CSS**

```css
/* ChangeNavControls.module.css */
.cluster {
  display: flex;
  align-items: center;
  gap: 2px;
}
.lead {
  display: inline-flex;
  color: var(--accent);
  margin-right: 4px;
}
.count {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-1);
  min-width: 3.5em; /* reserve width for the widest "M / M" so — / N doesn't jitter */
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--radius-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.chev:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--accent);
}
.chev:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 1px;
}
.chev:disabled {
  color: var(--text-disabled);
  cursor: default;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.tsx frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.module.css frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeNavControls.test.tsx
git commit -m "feat(diff): ChangeNavControls header cluster (#486)"
```

---

## Task 5: `ChangeMinimap` (the rail)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ChangeMinimap.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeMinimap } from './ChangeMinimap';
import type { ChangeTick } from './diffChanges';

const ticks: ChangeTick[] = [
  { kind: 'add', topPct: 10, heightPct: 1, startLineNum: 10, addCount: 2, delCount: 0 },
  { kind: 'delete', topPct: 40, heightPct: 1, startLineNum: 20, addCount: 0, delCount: 1 },
  { kind: 'modify', topPct: 70, heightPct: 2, startLineNum: 30, addCount: 1, delCount: 1 },
];
const viewport = { topPct: 0, heightPct: 30 };

describe('ChangeMinimap', () => {
  it('renders one tick per change with a kind data-attr', () => {
    const { getAllByTestId } = render(
      <ChangeMinimap ticks={ticks} viewport={viewport} onGoToChange={() => {}} onScrollToRatio={() => {}} />,
    );
    const els = getAllByTestId('change-tick');
    expect(els).toHaveLength(3);
    expect(els[0]).toHaveAttribute('data-kind', 'add');
    expect(els[2]).toHaveAttribute('data-kind', 'modify');
  });

  it('jumps to a change when a tick is clicked', async () => {
    const onGo = vi.fn();
    const { getAllByTestId } = render(
      <ChangeMinimap ticks={ticks} viewport={viewport} onGoToChange={onGo} onScrollToRatio={() => {}} />,
    );
    await userEvent.click(getAllByTestId('change-tick')[1]);
    expect(onGo).toHaveBeenCalledWith(1);
  });

  it('is hidden from the accessibility tree', () => {
    const { container } = render(
      <ChangeMinimap ticks={ticks} viewport={viewport} onGoToChange={() => {}} onScrollToRatio={() => {}} />,
    );
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the component**

```tsx
// ChangeMinimap.tsx
import { useRef, useState } from 'react';
import styles from './ChangeMinimap.module.css';
import type { ChangeTick } from './diffChanges';

export interface ChangeMinimapProps {
  ticks: ChangeTick[];
  viewport: { topPct: number; heightPct: number };
  onGoToChange: (i: number) => void;
  onScrollToRatio: (r: number) => void;
}

export function ChangeMinimap({ ticks, viewport, onGoToChange, onScrollToRatio }: ChangeMinimapProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const onRailClick = (e: React.MouseEvent) => {
    // Only when the empty rail (not a tick) is clicked.
    if ((e.target as HTMLElement).dataset.tick !== undefined) return;
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    onScrollToRatio((e.clientY - rect.top) / rect.height);
  };

  return (
    <div ref={railRef} className={styles.rail} aria-hidden="true" onClick={onRailClick}>
      <div className={styles.viewport} style={{ top: `${viewport.topPct}%`, height: `${viewport.heightPct}%` }} />
      {ticks.map((t, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          data-tick=""
          data-testid="change-tick"
          data-kind={t.kind}
          className={styles.tick}
          style={{ top: `${t.topPct}%`, height: `max(3px, ${t.heightPct}%)` }}
          onClick={() => onGoToChange(i)}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
        >
          <span className={styles.lineNum}>{t.startLineNum}</span>
        </button>
      ))}
      {hovered !== null && (
        <div className={styles.tooltip} style={{ top: `${ticks[hovered].topPct}%` }}>
          change {hovered + 1} of {ticks.length} · L{ticks[hovered].startLineNum} · +{ticks[hovered].addCount} −{ticks[hovered].delCount}
        </div>
      )}
    </div>
  );
}
```

> The hover tooltip here renders synchronously for testability; the ~100ms show-delay + timer cleanup is a CSS/transition concern applied in the CSS step (`transition-delay`) so no JS timer can leak onto an unmounted tick.

- [ ] **Step 4: Write the CSS**

```css
/* ChangeMinimap.module.css */
.rail {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  background: var(--surface-2);
  cursor: pointer;
  transition: width var(--t-med) var(--ease-out);
  z-index: 2;
}
.rail:hover {
  width: 48px;
  background: var(--surface-3);
}
@media (pointer: coarse) {
  .rail {
    width: 48px;
    background: var(--surface-3);
    transition: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rail {
    transition: none;
  }
}
.tick {
  position: absolute;
  right: 1px;
  width: 3px;
  min-height: 3px;
  border: 0;
  padding: 0;
  border-radius: 2px;
  cursor: pointer;
}
.rail:hover .tick,
@media (pointer: coarse) {
  /* widen tick targets when expanded — see expanded rule below */
}
.rail:hover .tick {
  right: 3px;
  width: 6px;
  border-radius: 3px;
}
.tick[data-kind='add'] {
  background: var(--success);
}
.tick[data-kind='delete'] {
  background: var(--danger);
}
.tick[data-kind='modify'] {
  background: var(--info);
}
.lineNum {
  position: absolute;
  right: 11px;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  white-space: nowrap;
  pointer-events: none;
}
.rail:hover .lineNum {
  opacity: 1;
}
@media (pointer: coarse) {
  .lineNum {
    opacity: 1;
  }
}
.viewport {
  position: absolute;
  left: 0;
  right: 0;
  border: 1px solid var(--border-strong);
  background: color-mix(in oklch, var(--text-1) 7%, transparent);
  border-radius: 3px;
  pointer-events: none;
}
.tooltip {
  position: absolute;
  right: 52px;
  transform: translateY(-50%);
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: var(--text-2xs);
  background: var(--surface-1);
  color: var(--text-1);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  box-shadow: var(--shadow-3);
  padding: 4px 9px;
  pointer-events: none;
  transition-delay: 100ms; /* show-delay; unmount clears it, no JS timer to leak */
}
@media (prefers-reduced-motion: reduce) {
  .tooltip {
    transition-delay: 0ms;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.tsx frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.module.css frontend/src/components/PrDetail/FilesTab/DiffChangeNav/ChangeMinimap.test.tsx
git commit -m "feat(diff): ChangeMinimap rail (#486)"
```

---

## Task 6: Wire into `DiffPane`

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffLineRow.tsx` and `SplitDiffLineRow.tsx` (forward `data-change-start`)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.changeNav.test.tsx` (new)

- [ ] **Step 1: Forward change-boundary attributes from the (inline) row components**

`DiffLineRow` (~`DiffPane.tsx:713`, props interface ~`:700`) and `SplitDiffLineRow` (~`:853`, props ~`:839`) are **module-private components inside `DiffPane.tsx`** — not separate files — and their `<tr>` lists explicit attributes (they do NOT spread arbitrary props). Add two optional props to each Props interface and render them on each component's outer `<tr>`:

```tsx
// add to DiffLineRowProps and SplitDiffLineRowProps:
dataChangeStart?: number;
dataChangeEnd?: number;

// and on each component's rendered <tr>:
<tr ... data-change-start={dataChangeStart} data-change-end={dataChangeEnd}>
```

(When a prop is `undefined`, React omits the attribute — no behavior change for non-boundary rows. Note: `SplitDiffLineRow` returns several `<tr>` variants by `kind` — `header` / `context` / `solo-delete` / `solo-insert` / `paired`. Only changed rows are ever tagged, so add the two attributes to the **`paired`, `solo-delete`, and `solo-insert`** branches' `<tr>` — not `header`/`context`.)

- [ ] **Step 2: Write the failing integration test**

```tsx
// DiffPane.changeNav.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DiffPane } from './DiffPane';
import type { FileChange, PrReference } from '../../../../api/types';
import { useAiGate } from '../../../../hooks/useAiGate';
import { useAiHunkAnnotations } from '../../../../hooks/useAiHunkAnnotations';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';

vi.mock('../../../../hooks/useAiGate');
vi.mock('../../../../hooks/useAiHunkAnnotations');
vi.mock('../../../../hooks/useWholeFileContent');

const prRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// Two separate change runs (two modify blocks split by context lines).
const twoRunFile: FileChange = {
  path: 'src/main.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 6,
      newStart: 1,
      newLines: 6,
      body: `@@ -1,6 +1,6 @@
 line one
-line two
+line two mod
 line three
 line four
-line five
+line five mod
 line six
`,
    },
  ],
};

function renderPane() {
  return render(
    <DiffPane
      prRef={prRef}
      selectedPath="src/main.ts"
      file={twoRunFile}
      diffMode="unified"
      truncated={false}
      reviewThreads={[]}
      prUrl=""
    />,
  );
}

describe('DiffPane change navigation', () => {
  beforeEach(() => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiHunkAnnotations).mockReturnValue(null);
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
  });

  it('renders the prev/next controls group in the header', () => {
    const { getByRole } = renderPane();
    expect(getByRole('group', { name: /change navigation/i })).toBeInTheDocument();
  });

  it('tags both boundary rows of each run (2 runs → 2 start + 2 end tags)', () => {
    const { container } = renderPane();
    expect(container.querySelectorAll('[data-change-start]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-change-end]')).toHaveLength(2);
  });

  it('does not render the rail (ticks) in hunks-only mode', () => {
    const { queryAllByTestId } = renderPane();
    expect(queryAllByTestId('change-tick')).toHaveLength(0);
  });
});
```

> The rail's *presence* in whole-file mode (and its rest/expanded visuals) needs real layout + scroll overflow, which jsdom does not compute — that is covered by the Playwright B1 gate (Task 8). These unit tests assert the mode-independent wiring: controls render, both boundary attributes are tagged once per run, and the rail is absent in hunks-only mode. (`wholeFileEnabled` is omitted, so DiffPane defaults to hunks mode; `allLines` = parsed hunk bodies → the same two runs.)
>
> **Keyboard coverage split:** do NOT write a jsdom test that dispatches `n`/`p` against DiffPane — jsdom has no layout, so `diffBodyRef.current.offsetParent` is always `null` (the visibility guard always early-returns) and measured offsets are all 0, making such a test either a false-green or impossible to assert. The `n`/`p` behavior is covered by two real layers instead: the **navigation math** (`goToNext`/`goToPrev`/`currentIdx`/clamp) is unit-tested in Task 3's hook test, and the **live key dispatch + visibility guard** is exercised in the Playwright B1 pass (Task 8: focus the diff, press `n`/`p`, assert the viewport moves and the counter advances; press `p` at change 1 and `n` at the last to confirm the clamp).

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/DiffPane.changeNav.test.tsx`
Expected: FAIL — no `role="group"` "Change navigation", no `data-change-start`.

- [ ] **Step 4: Wire `DiffPane.tsx`**

```tsx
// near the other imports
import { computeChanges } from '../DiffChangeNav/diffChanges';
import { useChangeNavigation } from '../DiffChangeNav/useChangeNavigation';
import { ChangeNavControls } from '../DiffChangeNav/ChangeNavControls';
import { ChangeMinimap } from '../DiffChangeNav/ChangeMinimap';
import { isInputTarget } from '../../../../hooks/isInputTarget';

// inside the component, after `allLines` is computed:
const tableRef = useRef<HTMLTableElement>(null);
const changes = useMemo(() => computeChanges(allLines), [allLines]);
const nav = useChangeNavigation(diffBodyRef, tableRef, changes);

// Boundary maps: allLines index -> change index, for the run's first and last rows.
const { changeStartMap, changeEndMap } = useMemo(() => {
  const start = new Map<number, number>();
  const end = new Map<number, number>();
  changes.forEach((c, i) => {
    start.set(c.startRowIdx, i);
    end.set(c.endRowIdx, i);
  });
  return { changeStartMap: start, changeEndMap: end };
}, [changes]);

// n/p keyboard: register ONCE per mount; read the latest handlers through a ref
// (mirrors useFilesTabShortcuts — avoids re-subscribing the document listener on
// every scroll-driven render). Visibility guard: keep-alive keeps other PR tabs and
// the non-Files subtab mounted but display:none (PrDetailView `hidden={subTab!=='files'}`,
// PrTabHost inactive views), so a hidden pane's diffBodyRef has offsetParent === null —
// skip it so hidden diffs never scroll or SR-announce.
const navRef = useRef(nav);
navRef.current = nav;
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'n' && e.key !== 'p') return;
    if (isInputTarget(e.target)) return;
    if (!diffBodyRef.current || diffBodyRef.current.offsetParent === null) return;
    if (e.key === 'n') navRef.current.goToNext();
    else navRef.current.goToPrev();
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, []);
```

In both renderers, attach the boundary attributes to each emitted row:

- **Unified** row at `idx` (one allLines entry): `dataChangeStart={changeStartMap.get(idx)} dataChangeEnd={changeEndMap.get(idx)}`.
- **Split paired** row (emitted at `idx`, consuming `idx + 1` — covers both indices): resolve each from either index — `dataChangeStart={changeStartMap.get(idx) ?? changeStartMap.get(idx + 1)} dataChangeEnd={changeEndMap.get(idx) ?? changeEndMap.get(idx + 1)}`. Split **solo** rows use the single-`idx` form.

A run's `startRowIdx` is its first changed row and `endRowIdx` its last; both resolve to a rendered `<tr>` in either layout, so the rail measures the run's true pixel span (Task 3 `measure()`).

Render the controls in the header (after the path span):

```tsx
<div className={`diff-pane-header ${styles.diffPaneHeader}`} data-testid="diff-pane-header">
  <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
  {changes.length > 0 && (
    <ChangeNavControls
      total={nav.total}
      currentIdx={nav.currentIdx}
      canPrev={nav.canPrev}
      canNext={nav.canNext}
      onPrev={nav.goToPrev}
      onNext={nav.goToNext}
    />
  )}
  {/* existing spinner / highlight-suppressed spans unchanged */}
</div>
```

Wrap the scroll body so the rail has a positioned container, add the `<table>` ref, and render the rail (whole-file + overflow only):

```tsx
<div className={styles.diffBodyWrap}>
  <div ref={diffBodyRef} className={`diff-pane-body ${styles.diffPaneBody} ${
    wholeFileEnabled && wholeFile.fetchStatus === 'loading' ? styles.diffPaneBodyLoading : ''
  }`}>
    {/* existing loading overlay unchanged */}
    <table ref={tableRef} className={`diff-table ${styles.diffTable}`}>
      {/* existing colgroup + tbody unchanged */}
    </table>
  </div>
  {wholeFileEnabled && wholeFile.fetchStatus === 'ok' && nav.hasOverflow && changes.length > 0 && (
    <ChangeMinimap
      ticks={nav.ticks}
      viewport={nav.viewport}
      onGoToChange={nav.goToChange}
      onScrollToRatio={nav.scrollToRatio}
    />
  )}
</div>
```

- [ ] **Step 5: Add the wrapper CSS**

In `DiffPane.module.css`:

```css
.diffBodyWrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.diffPaneBody {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable; /* reserve a stable scrollbar track so the rail never overlaps it */
}
```

(`.diffPaneBody` already had `flex/min-height/overflow` — keep those and add `scrollbar-gutter`.)

- [ ] **Step 6: Run the integration test**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/DiffPane.changeNav.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the full DiffPane + FilesTab suites to confirm no regression**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/FilesTab`
Expected: PASS (existing DiffPane/FilesTab tests still green).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane
git commit -m "feat(diff): wire change-nav minimap + controls + n/p into DiffPane (#486)"
```

---

## Task 7: Shortcut discoverability (cheatsheet + CTA)

**Files:**
- Modify: `frontend/src/components/Cheatsheet/shortcuts.ts`
- Modify: `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx`
- Test: extend the existing cheatsheet test if present, else add `shortcuts.test.ts`

- [ ] **Step 1: Write/extend the failing test**

```typescript
// shortcuts.test.ts (or add to the existing cheatsheet test)
import { describe, it, expect } from 'vitest';
import { SHORTCUTS } from './shortcuts';

describe('SHORTCUTS', () => {
  it('lists n and p in the Diff group', () => {
    const diff = SHORTCUTS.find((g) => g.group === 'Diff');
    const keys = diff?.rows.map((r) => r.keys) ?? [];
    expect(keys).toContain('n');
    expect(keys).toContain('p');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Cheatsheet/shortcuts.test.ts`
Expected: FAIL — `n`/`p` not present.

- [ ] **Step 3: Add the rows to the "Diff" group**

```typescript
{
  group: 'Diff',
  rows: [
    { keys: 'd', context: 'Files tab', action: 'Toggle Unified / Split diff' },
    { keys: 'n', context: 'Files tab', action: 'Jump to next change' },
    { keys: 'p', context: 'Files tab', action: 'Jump to previous change' },
  ],
},
```

- [ ] **Step 4: Update the `ReviewFilesCta` hint**

```tsx
<p className={`${styles.overviewCtaFooter} muted`}>
  <kbd>j</kbd> next file · <kbd>k</kbd> previous · <kbd>v</kbd> mark viewed · <kbd>n</kbd>/<kbd>p</kbd> next/prev change
</p>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Cheatsheet/shortcuts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Cheatsheet/shortcuts.ts frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx frontend/src/components/Cheatsheet/shortcuts.test.ts
git commit -m "feat(diff): surface n/p change-nav keys in cheatsheet + CTA (#486)"
```

---

## Task 8: Visual baselines (B1 gate) + full verification

**Files:**
- Modify/add: the Files-tab Playwright spec that captures the diff pane (mirror the existing diff/PR-detail visual specs under `frontend/e2e/`).

- [ ] **Step 1: Add visual + interaction coverage** for: (a) the rail at rest and expanded, (b) the header controls, (c) a **modify-heavy** diff (color mix), (d) a **dense** diff (tick legibility) — in both themes; plus (e) a **keyboard behavior** check: focus the diff in whole-file mode, press `n`/`p` and assert the viewport scrolls and the counter advances, and that `p` at change 1 / `n` at the last change are no-ops (clamp). Follow the existing e2e baseline pattern in the repo (the same harness used by prior diff/header visual specs).

- [ ] **Step 2: Generate baselines from CI** (Linux baselines are authoritative in this repo — regen from the CI artifact, do not commit local win32 captures).

- [ ] **Step 3: Run the full pre-push checklist** (per `.ai/docs/development-process.md`): frontend typecheck (`tsc -b`), lint, prettier (use the real binary, not the rtk proxy), full vitest, and the backend build/tests if touched (this change is frontend-only).

Run: `cd frontend && node_modules/.bin/vitest run` then the repo's typecheck/lint/format commands.
Expected: all green.

- [ ] **Step 4: Manual live validation** against the running app (real token store, both themes) — confirm: rail pinned (doesn't scroll), tick colors, hover-expand + line numbers + tooltip, tick-click jump, rail-click scrub, prev/next + `n`/`p` with the counter and SR announcement, clamp at ends, hunks-only mode has controls but no rail, no-overflow file hides the rail.

- [ ] **Step 5: Commit baselines**

```bash
git add frontend/e2e
git commit -m "test(diff): visual baselines for change-nav rail + controls (#486)"
```

---

## Self-review (completed against the spec)

- **Spec coverage:** change model (T1), rail overlay + ticks + viewport + hover + tooltip + scrubber (T5/T6), prev/next + counter + clamp + focus + keyboard (T4/T6), discoverability (T7), a11y live region + aria-hidden rail (T4/T5), both modes + scope (T6), measurement + observers + suppression (T3), edge cases incl. no-overflow + loading/error (T3/T6), visual B1 (T8). All spec sections map to a task.
- **Type consistency:** `DiffChange`, `ChangeTick`, `ChangeNavState`, and the component prop names are defined in T1/T3 and consumed verbatim in T4/T5/T6.
- **Placeholders:** the only deferred-to-implementer detail is the DiffPane integration-test *fixture* (T6 Step 2), which must be copied from the sibling `DiffPane.test.tsx` harness — flagged explicitly with the source to copy, not left blank.

## Open decisions carried from the spec

- Expanded-rail line number: single start line (chosen). Range deferred unless review pushes back.
