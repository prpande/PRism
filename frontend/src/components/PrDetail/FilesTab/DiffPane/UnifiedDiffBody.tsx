import { memo } from 'react';
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
  replyContext,
  collapse,
  changeStartMap,
  changeEndMap,
}: DiffBodyProps) {
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
        replyContext={replyContext}
        collapse={collapse}
      />,
    );
  }
  return <>{rows}</>;
});
