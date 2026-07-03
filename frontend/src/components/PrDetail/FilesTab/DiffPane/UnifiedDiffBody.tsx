import { memo, useMemo } from 'react';
import type { DiffLine } from '../../../../api/types';
import { hunkAnnotationRows, preLineAnnotationRows } from './AnnotationRows';
import { DiffLineRow } from './DiffLineRow';
import type { DiffBodyProps } from './diffBodyProps';

function findAdjacentPair(lines: DiffLine[], idx: number): DiffLine | null {
  const line = lines[idx];
  if (line.type === 'delete') {
    const next = lines[idx + 1];
    if (next?.type === 'insert') return next;
  }
  if (line.type === 'insert') {
    const prev = lines[idx - 1];
    if (prev?.type === 'delete') return prev;
  }
  return null;
}

// Unified-mode diff body: the former renderUnifiedRows closure with its
// captured scope made explicit as props. Renders the <tr> list; the <tbody>
// element stays in DiffPane so the table skeleton is unchanged.
//
// Memoized so a body-irrelevant DiffPane re-render (scroll capture, nav state)
// skips the whole row-building loop when every prop is referentially stable.
// Default shallow compare is correct: the output is a pure function of these
// props, and DiffPane memoizes every derived structure it passes down.
export const UnifiedDiffBody = memo(function UnifiedDiffBody({
  selectedPath: path,
  lines,
  threadsByLine,
  annotationsForFile,
  annotationsByRowIdx,
  wholeFileOk,
  colSpan,
  syntax,
  onLineClick,
  renderComposerForLine,
  activeComposerKey,
  replyContext,
  collapse,
  changeStartMap,
  changeEndMap,
}: DiffBodyProps) {
  // #327 Task 12 — per-row composer-content stamp. The key is parsed ONCE per
  // (key, path) change into a numeric line → stamp map: NUL-joined ('\0' —
  // the one character git forbids in paths; '|', '=' and ':' are all legal)
  // `${filePath}:${lineNumber}=${stamp}` entries. The stamp is
  // `c:${draftId}:${anyOtherDraftsStaged}` for the open composer plus
  // placeholder clientIds — this parse never interprets it, only per-row
  // equality matters. Each entry splits at its LAST '=' (stamps never contain
  // '='), then at the location's LAST ':' (file paths may contain ':'),
  // keeping only entries for the current file. Each row gets its own stamp
  // (or null), NEVER the raw key (the raw key would break every row's memo on
  // each composer move — the per-row stamp re-renders exactly the rows whose
  // composer content appears, changes, or leaves; a mere boolean would miss
  // the same-line composer→placeholder swap after post-now). CRITICAL: this
  // parse must stay format-identical to the key builder in FilesTab's
  // activeComposerKey memo; a mismatch silently defeats the whole mechanism
  // (guarded by FilesTab.renderCount.perf.test.tsx).
  const composerStamps = useMemo(() => {
    if (activeComposerKey === null) return null;
    const stamps = new Map<number, string>();
    for (const entry of activeComposerKey.split('\0')) {
      const eq = entry.lastIndexOf('=');
      if (eq === -1) continue; // malformed entry — skip rather than mis-map
      const loc = entry.slice(0, eq);
      const colon = loc.lastIndexOf(':');
      if (colon === -1 || loc.slice(0, colon) !== path) continue;
      const lineNumber = Number(loc.slice(colon + 1));
      if (!Number.isFinite(lineNumber)) continue;
      stamps.set(lineNumber, entry.slice(eq + 1));
    }
    return stamps;
  }, [activeComposerKey, path]);
  const composerStampFor = (commentLineNum: number | null): string | null =>
    commentLineNum === null || composerStamps === null
      ? null
      : (composerStamps.get(commentLineNum) ?? null);

  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      if (!wholeFileOk) {
        // Hunks-only mode: emit the hunk-header row + per-hunk AI annotations.
        const commentLineNum = line.newLineNum;
        const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
        const pair = findAdjacentPair(lines, idx);
        rows.push(
          <DiffLineRow
            key={idx}
            line={line}
            pair={pair}
            threadsAtLine={threadsAtLine}
            filePath={path}
            colSpan={colSpan}
            syntax={syntax}
            onLineClick={onLineClick}
            renderComposerForLine={renderComposerForLine}
            composerStamp={composerStampFor(commentLineNum)}
            replyContext={replyContext}
            collapse={collapse}
          />,
        );
        rows.push(...hunkAnnotationRows(annotationsForFile, hunkCounter, idx, colSpan));
      }
      // Whole-file ok mode: emit nothing for the hunk-header itself.
      continue;
    }

    // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
    if (wholeFileOk) {
      rows.push(...preLineAnnotationRows(annotationsByRowIdx, idx, colSpan));
    }

    const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
    const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
    const pair = findAdjacentPair(lines, idx);

    rows.push(
      <DiffLineRow
        key={idx}
        line={line}
        pair={pair}
        threadsAtLine={threadsAtLine}
        filePath={path}
        colSpan={colSpan}
        syntax={syntax}
        isFilled={line.isFilled}
        dataChangeStart={changeStartMap.get(idx)}
        dataChangeEnd={changeEndMap.get(idx)}
        onLineClick={onLineClick}
        renderComposerForLine={renderComposerForLine}
        composerStamp={composerStampFor(commentLineNum)}
        replyContext={replyContext}
        collapse={collapse}
      />,
    );
  }
  return <>{rows}</>;
});
