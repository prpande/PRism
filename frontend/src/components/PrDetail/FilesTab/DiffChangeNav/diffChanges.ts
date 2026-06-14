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
