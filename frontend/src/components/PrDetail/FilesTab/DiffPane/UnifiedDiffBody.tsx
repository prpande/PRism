import type { DiffLine } from '../../../../api/types';
import { annotationRows } from './AnnotationRows';
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
export function UnifiedDiffBody({
  selectedPath,
  lines,
  threadsByLine,
  annotationsForFile,
  annotationsByRowIdx,
  wholeFileEnabled,
  wholeFileFetchStatus,
  colSpan,
  syntax,
  onLineClick,
  renderComposerForLine,
  replyContext,
  collapse,
  changeStartMap,
  changeEndMap,
}: DiffBodyProps) {
  const path = selectedPath;
  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      if (!wholeFileEnabled || wholeFileFetchStatus !== 'ok') {
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
        const annotations = annotationsForFile?.get(hunkCounter);
        if (annotations) {
          rows.push(...annotationRows({ annotations, colSpan, keyPrefix: `ann-${idx}` }));
        }
      }
      // Whole-file ok mode: emit nothing for the hunk-header itself.
      continue;
    }

    // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
    if (wholeFileEnabled && wholeFileFetchStatus === 'ok' && annotationsByRowIdx) {
      const ann = annotationsByRowIdx.get(idx);
      if (ann) {
        rows.push(...annotationRows({ annotations: ann, colSpan, keyPrefix: `ann-${idx}` }));
      }
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
}
