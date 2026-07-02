import { memo } from 'react';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import { annotationRows } from './AnnotationRows';
import { SplitDiffLineRow } from './SplitDiffLineRow';
import type { DiffBodyProps } from './diffBodyProps';
import styles from './DiffPane.module.css';

// Split-mode diff body: the former renderSplitRows closure (including its
// emitWidgetAndComposerRows helper) with its captured scope made explicit as
// props. Renders the <tr> list; the <tbody> element stays in DiffPane so the
// table skeleton is unchanged.
//
// Memoized so a body-irrelevant DiffPane re-render (scroll capture, nav state)
// skips the whole row-building loop when every prop is referentially stable.
// Default shallow compare is correct: the output is a pure function of these
// props, and DiffPane memoizes every derived structure it passes down.
export const SplitDiffBody = memo(function SplitDiffBody({
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

  // Inline helper — emits an ExistingCommentWidget row (if threadsByLine has
  // entries for the right-side line number) followed by a composer-slot row
  // (if renderComposerForLine returns non-null). Both use the mode-aware
  // colSpan. Solo-delete and hunk-header rows do NOT call this helper — they
  // have no right-side line number to anchor to, consistent with
  // unified-mode behavior.
  function emitWidgetAndComposerRows(idx: number, anchorLineNum: number | null): void {
    if (anchorLineNum == null) return;
    const threads = threadsByLine.get(anchorLineNum);
    if (threads && threads.length > 0) {
      rows.push(
        <tr key={`widget-${idx}`} className={`diff-comment-row ${styles.diffCommentRow}`}>
          <td colSpan={colSpan}>
            <div className={styles.diffStickyViewport}>
              <ExistingCommentWidget
                threads={threads}
                replyContext={replyContext}
                collapse={collapse}
              />
            </div>
          </td>
        </tr>,
      );
    }
    if (renderComposerForLine) {
      const node = renderComposerForLine(path, anchorLineNum);
      if (node) {
        rows.push(
          <tr key={`composer-${idx}`} className={`diff-composer-row ${styles.diffComposerRow}`}>
            <td colSpan={colSpan}>
              <div className={styles.diffStickyViewport}>{node}</div>
            </td>
          </tr>,
        );
      }
    }
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      if (!wholeFileEnabled || wholeFileFetchStatus !== 'ok') {
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="header"
            content={line.content}
            filePath={path}
            syntax={syntax}
          />,
        );
        const annotations = annotationsForFile?.get(hunkCounter);
        if (annotations) {
          rows.push(...annotationRows({ annotations, colSpan, keyPrefix: `ann-${idx}` }));
        }
      }
      continue;
    }

    // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
    if (wholeFileEnabled && wholeFileFetchStatus === 'ok' && annotationsByRowIdx) {
      const ann = annotationsByRowIdx.get(idx);
      if (ann) {
        rows.push(...annotationRows({ annotations: ann, colSpan, keyPrefix: `ann-${idx}` }));
      }
    }

    if (line.type === 'context') {
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="context"
          oldLineNum={line.oldLineNum}
          newLineNum={line.newLineNum}
          content={line.content}
          filePath={path}
          syntax={syntax}
          isFilled={line.isFilled}
          isAnchored={!!threadsByLine.get(line.newLineNum ?? -1)?.length}
          onLineClick={onLineClick}
        />,
      );
      emitWidgetAndComposerRows(idx, line.newLineNum);
      continue;
    }

    if (line.type === 'delete') {
      const next = lines[idx + 1];
      if (next?.type === 'insert') {
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="paired"
            oldLineNum={line.oldLineNum}
            newLineNum={next.newLineNum}
            oldText={line.content}
            newText={next.content}
            filePath={path}
            syntax={syntax}
            isAnchored={!!threadsByLine.get(next.newLineNum ?? -1)?.length}
            dataChangeStart={changeStartMap.get(idx) ?? changeStartMap.get(idx + 1)}
            dataChangeEnd={changeEndMap.get(idx) ?? changeEndMap.get(idx + 1)}
            onLineClick={onLineClick}
          />,
        );
        emitWidgetAndComposerRows(idx, next.newLineNum);
        idx += 1; // consume the paired insert; the for-loop's ++ advances past it
        continue;
      }
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="solo-delete"
          oldLineNum={line.oldLineNum}
          content={line.content}
          filePath={path}
          syntax={syntax}
          dataChangeStart={changeStartMap.get(idx)}
          dataChangeEnd={changeEndMap.get(idx)}
        />,
      );
      continue;
    }

    if (line.type === 'insert') {
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="solo-insert"
          newLineNum={line.newLineNum}
          content={line.content}
          filePath={path}
          syntax={syntax}
          isAnchored={!!threadsByLine.get(line.newLineNum ?? -1)?.length}
          dataChangeStart={changeStartMap.get(idx)}
          dataChangeEnd={changeEndMap.get(idx)}
          onLineClick={onLineClick}
        />,
      );
      emitWidgetAndComposerRows(idx, line.newLineNum);
      continue;
    }
  }
  return <>{rows}</>;
});
