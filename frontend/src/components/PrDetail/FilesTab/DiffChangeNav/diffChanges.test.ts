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

  it('reads startLineNum from a pure-delete run that starts at index 0', () => {
    const out = computeChanges([del(7), del(8), ctx(9)]);
    expect(out).toEqual([
      { kind: 'delete', startRowIdx: 0, endRowIdx: 1, startLineNum: 7, addCount: 0, delCount: 2 },
    ]);
  });

  it('classifies a delete-then-insert block as a single modify', () => {
    const out = computeChanges([del(5), del(6), ins(5), ins(6)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'modify', startRowIdx: 0, endRowIdx: 3, startLineNum: 5 });
  });

  it('splits runs on context, hunk-header, and filled rows', () => {
    const filled: DiffLine = {
      type: 'context',
      content: 'x',
      oldLineNum: 9,
      newLineNum: 9,
      isFilled: true,
    };
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

  it('returns empty when scrollHeight is not yet measured', () => {
    const changes = computeChanges([ins(1)]);
    expect(computeTicks(changes, [], 0)).toEqual([]);
  });
});
