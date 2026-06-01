import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileChange,
  ReviewThreadDto,
  DraftSide,
  PrReference,
  HunkAnnotation,
  DiffLine,
} from '../../../../api/types';
import { parseHunkLines, interleaveWholeFile } from './interleaveWholeFile';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import {
  ExistingCommentWidget,
  type ExistingCommentWidgetReplyContext,
} from './ExistingCommentWidget';
import { DiffTruncationBanner } from './DiffTruncationBanner';
import { WordDiffOverlay } from './WordDiffOverlay';
import { AiHunkAnnotation } from './AiHunkAnnotation';
import { useAiGate } from '../../../../hooks/useAiGate';
import { useAiHunkAnnotations } from '../../../../hooks/useAiHunkAnnotations';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';
import { WholeFileFailureBanner } from './WholeFileFailureBanner';
import styles from './DiffPane.module.css';

export type DiffMode = 'side-by-side' | 'unified';

export interface DiffPaneProps {
  prRef: PrReference;
  selectedPath: string | null;
  file: FileChange | null;
  diffMode: DiffMode;
  truncated: boolean;
  reviewThreads: ReviewThreadDto[];
  prUrl: string;
  // Spec § 5.3a: clicking an "Add comment" affordance on a diff line opens
  // an InlineCommentComposer at that line. The handler is owned by FilesTab
  // because the composer's lifecycle (and the A2 click-another-line modal)
  // is sibling-state to the diff view.
  onLineClick?: (anchor: InlineAnchor) => void;
  // Optional renderer for an inline composer mounted on the clicked line.
  // FilesTab passes its <InlineCommentComposer> here; DiffPane simply
  // inserts it as a full-width follow-up row analogous to ExistingCommentWidget.
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  // Bound by FilesTab from its `useDraftSession`. Forwarded verbatim to each
  // `<ExistingCommentWidget>` so per-thread Reply buttons can mount a
  // `<ReplyComposer>`. Absent → DiffPane test harnesses render threads
  // read-only.
  replyContext?: ExistingCommentWidgetReplyContext;
  // D36 — when true, renders a Loading… span in the diff-pane header. JSX
  // (not CSS ::after) so screen readers announce it (WCAG 2.1 F87).
  isLoading?: boolean;

  // Slice 2 additions (all optional with defaults — see destructuring below):
  wholeFileEnabled?: boolean;
  onWholeFileFailed?: (reason: string) => void;
  headSha?: string;
  baseSha?: string;
}

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

export function DiffPane({
  prRef,
  selectedPath,
  file,
  diffMode,
  truncated,
  reviewThreads,
  prUrl,
  onLineClick,
  renderComposerForLine,
  replyContext,
  isLoading = false,
  wholeFileEnabled = false,
  onWholeFileFailed,
  headSha = '',
  baseSha = '',
}: DiffPaneProps) {
  const annotationsEnabled = useAiGate('hunkAnnotations');
  const allAnnotations = useAiHunkAnnotations(prRef, annotationsEnabled);

  const annotationsForFile = useMemo(() => {
    if (!allAnnotations || !selectedPath) return null;
    const m = new Map<number, HunkAnnotation[]>();
    for (const a of allAnnotations) {
      if (a.path !== selectedPath) continue;
      const existing = m.get(a.hunkIndex);
      if (existing) existing.push(a);
      else m.set(a.hunkIndex, [a]);
    }
    return m;
  }, [allAnnotations, selectedPath]);

  // Hook ordering rule: isSplit must be computed before the hook call so it
  // can be passed as a parameter.
  const isSplit = diffMode === 'side-by-side';

  const wholeFile = useWholeFileContent({
    prRef,
    path: selectedPath,
    file,
    headSha,
    baseSha,
    enabled: wholeFileEnabled,
    isSplit,
  });

  // Failure latch: fires onWholeFileFailed once per transition to 'failed'.
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const prevStatus = useRef<typeof wholeFile.fetchStatus>('idle');

  useEffect(() => {
    if (
      prevStatus.current !== 'failed' &&
      wholeFile.fetchStatus === 'failed' &&
      wholeFile.failureReason
    ) {
      setLocalFailure(wholeFile.failureReason);
      onWholeFileFailed?.(wholeFile.failureReason);
    }
    prevStatus.current = wholeFile.fetchStatus;
  }, [wholeFile.fetchStatus, wholeFile.failureReason, onWholeFileFailed]);

  const dismissBanner = () => {
    const reason = localFailure;
    setLocalFailure(null);
    if (selectedPath && reason) onWholeFileFailed?.(reason);
  };

  // allLines: whole-file branch takes over when enabled + ok; else plain hunk
  // parsing.
  const allLines: DiffLine[] = useMemo(() => {
    if (!file) return [];
    if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && wholeFile.headContent !== null) {
      return interleaveWholeFile(file, wholeFile.headContent, wholeFile.baseContent);
    }
    const out: DiffLine[] = [];
    for (const hunk of file.hunks) {
      out.push(...parseHunkLines(hunk.body));
    }
    return out;
  }, [file, wholeFileEnabled, wholeFile.fetchStatus, wholeFile.headContent, wholeFile.baseContent]);

  // AI annotation re-anchoring map for whole-file mode: maps row idx → annotations
  // that should render before that row (first non-header line after each hunk-header).
  const annotationsByRowIdx = useMemo(() => {
    if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') return null;
    const map = new Map<number, HunkAnnotation[]>();
    const consumedHunks = new Set<number>();
    let hunkCounter = -1;
    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];
      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        continue;
      }
      if (hunkCounter >= 0 && !consumedHunks.has(hunkCounter)) {
        const ann = annotationsForFile?.get(hunkCounter);
        if (ann) map.set(idx, ann);
        consumedHunks.add(hunkCounter);
      }
    }
    return map;
  }, [wholeFileEnabled, wholeFile.fetchStatus, allLines, annotationsForFile]);

  // Scroll reset on wholeFileEnabled toggle or file navigation.
  const diffBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (diffBodyRef.current) diffBodyRef.current.scrollTop = 0;
  }, [wholeFileEnabled, selectedPath]);

  // ---- Early-return guards (all hooks must be above here) ----

  if (!selectedPath) {
    return (
      <div
        className={`diff-pane diff-pane--empty ${styles.diffPane} ${styles.diffPaneEmpty}`}
        data-testid="diff-pane"
      >
        <p className="muted">Select a file from the tree to view its diff.</p>
      </div>
    );
  }

  // Loading-state branch — intercept in-flight fetches before the empty-file
  // branch fires. Without this, a `file === null` mid-fetch falsely renders
  // "Empty file — no changes to display." (Copilot iter 1 #1).
  if (isLoading && !file) {
    return (
      <div className={`diff-pane ${styles.diffPane}`} data-testid="diff-pane">
        <div className={`diff-pane-header ${styles.diffPaneHeader}`}>
          <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
          <span
            className={`diff-pane-loading muted ${styles.diffPaneLoading}`}
            role="status"
            aria-live="polite"
          >
            Loading…
          </span>
        </div>
      </div>
    );
  }

  if (!file || file.hunks.length === 0) {
    return (
      <div className={`diff-pane ${styles.diffPane}`} data-testid="diff-pane">
        <div className={`diff-pane-header ${styles.diffPaneHeader}`}>
          <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
        </div>
        <div className={`diff-pane-body muted ${styles.diffPaneBody}`}>
          Empty file — no changes to display.
        </div>
      </div>
    );
  }

  const fileThreads = reviewThreads.filter((t) => t.filePath === selectedPath);
  const threadsByLine = new Map<number, ReviewThreadDto[]>();
  for (const t of fileThreads) {
    const existing = threadsByLine.get(t.lineNumber) ?? [];
    existing.push(t);
    threadsByLine.set(t.lineNumber, existing);
  }

  const colSpan = isSplit ? 4 : 3;
  const modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified';

  function renderDiffRows(): React.ReactNode[] {
    if (isSplit) return renderSplitRows();
    return renderUnifiedRows();
  }

  function renderUnifiedRows(): React.ReactNode[] {
    const path = selectedPath ?? '';
    const rows: React.ReactNode[] = [];
    let hunkCounter = -1;
    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];

      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') {
          // Hunks-only mode: emit the hunk-header row + per-hunk AI annotations.
          const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
          const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
          const pair = findAdjacentPair(allLines, idx);
          rows.push(
            <DiffLineRow
              key={idx}
              line={line}
              pair={pair}
              threadsAtLine={threadsAtLine}
              filePath={path}
              colSpan={colSpan}
              onLineClick={onLineClick}
              renderComposerForLine={renderComposerForLine}
              replyContext={replyContext}
            />,
          );
          const annotations = annotationsForFile?.get(hunkCounter);
          if (annotations) {
            for (let aidx = 0; aidx < annotations.length; aidx++) {
              rows.push(
                <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                  <td colSpan={colSpan}>
                    <AiHunkAnnotation annotation={annotations[aidx]} />
                  </td>
                </tr>,
              );
            }
          }
        }
        // Whole-file ok mode: emit nothing for the hunk-header itself.
        continue;
      }

      // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
      if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && annotationsByRowIdx) {
        const ann = annotationsByRowIdx.get(idx);
        if (ann) {
          for (let aidx = 0; aidx < ann.length; aidx++) {
            rows.push(
              <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                <td colSpan={colSpan}>
                  <AiHunkAnnotation annotation={ann[aidx]} />
                </td>
              </tr>,
            );
          }
        }
      }

      const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
      const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
      const pair = findAdjacentPair(allLines, idx);

      rows.push(
        <DiffLineRow
          key={idx}
          line={line}
          pair={pair}
          threadsAtLine={threadsAtLine}
          filePath={path}
          colSpan={colSpan}
          isFilled={line.isFilled}
          onLineClick={onLineClick}
          renderComposerForLine={renderComposerForLine}
          replyContext={replyContext}
        />,
      );
    }
    return rows;
  }

  function renderSplitRows(): React.ReactNode[] {
    const path = selectedPath ?? '';
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
              <ExistingCommentWidget threads={threads} replyContext={replyContext} />
            </td>
          </tr>,
        );
      }
      if (renderComposerForLine) {
        const node = renderComposerForLine(path, anchorLineNum);
        if (node) {
          rows.push(
            <tr key={`composer-${idx}`} className={`diff-composer-row ${styles.diffComposerRow}`}>
              <td colSpan={colSpan}>{node}</td>
            </tr>,
          );
        }
      }
    }

    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];

      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') {
          rows.push(
            <SplitDiffLineRow key={idx} kind="header" content={line.content} filePath={path} />,
          );
          const annotations = annotationsForFile?.get(hunkCounter);
          if (annotations) {
            for (let aidx = 0; aidx < annotations.length; aidx++) {
              rows.push(
                <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                  <td colSpan={colSpan}>
                    <AiHunkAnnotation annotation={annotations[aidx]} />
                  </td>
                </tr>,
              );
            }
          }
        }
        continue;
      }

      // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
      if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && annotationsByRowIdx) {
        const ann = annotationsByRowIdx.get(idx);
        if (ann) {
          for (let aidx = 0; aidx < ann.length; aidx++) {
            rows.push(
              <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                <td colSpan={colSpan}>
                  <AiHunkAnnotation annotation={ann[aidx]} />
                </td>
              </tr>,
            );
          }
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
            isFilled={line.isFilled}
            onLineClick={onLineClick}
          />,
        );
        emitWidgetAndComposerRows(idx, line.newLineNum);
        continue;
      }

      if (line.type === 'delete') {
        const next = allLines[idx + 1];
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
            onLineClick={onLineClick}
          />,
        );
        emitWidgetAndComposerRows(idx, line.newLineNum);
        continue;
      }
    }
    return rows;
  }

  return (
    <div className={`diff-pane ${modeClass} ${styles.diffPane}`} data-testid="diff-pane">
      <div className={`diff-pane-header ${styles.diffPaneHeader}`}>
        <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
        {isLoading && (
          <span
            className={`diff-pane-loading muted ${styles.diffPaneLoading}`}
            role="status"
            aria-live="polite"
          >
            Loading…
          </span>
        )}
      </div>
      {localFailure !== null && (
        <WholeFileFailureBanner reason={localFailure} onDismiss={dismissBanner} />
      )}
      <div
        ref={diffBodyRef}
        className={`diff-pane-body ${styles.diffPaneBody} ${
          wholeFileEnabled && wholeFile.fetchStatus === 'loading'
            ? (styles.diffPaneBodyLoading ?? '')
            : ''
        }`}
      >
        {wholeFileEnabled && wholeFile.fetchStatus === 'loading' && (
          <div role="status" aria-live="polite" className={styles.diffPaneLoadingOverlay ?? ''}>
            Loading whole file…
          </div>
        )}
        <table className={`diff-table ${styles.diffTable}`}>
          {isSplit && (
            <colgroup>
              <col style={{ width: '3em' }} />
              <col />
              <col style={{ width: '3em' }} />
              <col />
            </colgroup>
          )}
          <tbody>{renderDiffRows()}</tbody>
        </table>
      </div>
      {truncated && <DiffTruncationBanner prUrl={prUrl} />}
    </div>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  pair: DiffLine | null;
  threadsAtLine: ReviewThreadDto[] | undefined;
  filePath: string;
  colSpan: number;
  isFilled?: boolean;
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  replyContext?: ExistingCommentWidgetReplyContext;
}

function DiffLineRow({
  line,
  pair,
  threadsAtLine,
  filePath,
  colSpan,
  isFilled,
  onLineClick,
  renderComposerForLine,
  replyContext,
}: DiffLineRowProps) {
  const rowClass = `diff-line diff-line--${line.type}`;

  const renderContent = () => {
    if (line.type === 'hunk-header') {
      return <span className={`diff-hunk-header ${styles.diffHunkHeader}`}>{line.content}</span>;
    }

    if ((line.type === 'insert' || line.type === 'delete') && pair) {
      const oldText = line.type === 'delete' ? line.content : pair.content;
      const newText = line.type === 'insert' ? line.content : pair.content;
      return <WordDiffOverlay oldText={oldText} newText={newText} type={line.type} />;
    }

    return <span>{line.content}</span>;
  };

  // PoC scope: only right-side (insert/context) clicks open the composer.
  // Left-side (deleted-line) commenting is deferred — its anchoredSha would
  // need to be the iteration's beforeSha, but FilesTab currently uses
  // prDetail.pr.headSha as the anchor (see deferrals doc). Once the
  // anchoredSha-by-iteration plumbing lands, this gate can flip to allow
  // line.type === 'delete' as well.
  const commentLineNum = line.newLineNum;
  const side: DraftSide = 'right';
  const canComment =
    onLineClick && commentLineNum !== null && (line.type === 'insert' || line.type === 'context');

  const handleClick = () => {
    if (!canComment || commentLineNum === null) return;
    onLineClick({
      filePath,
      lineNumber: commentLineNum,
      side,
      // anchoredSha is left empty here — DiffPane has no PR-detail context.
      // FilesTab.openComposerAt fills it in (PoC simplification: always
      // prDetail.pr.headSha; iteration-relative anchoring is deferred and
      // only right-side clicks are enabled, so headSha is always a valid
      // anchor for the right side).
      anchoredSha: '',
      anchoredLineContent: line.content,
    });
  };

  return (
    <>
      <tr className={rowClass} {...(isFilled ? { 'data-fill': 'true' } : {})}>
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {line.oldLineNum ?? ''}
        </td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {commentLineNum !== null && canComment ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${commentLineNum}`}
              onClick={handleClick}
            >
              {line.newLineNum ?? line.oldLineNum ?? ''}
            </button>
          ) : (
            (line.newLineNum ?? '')
          )}
        </td>
        <td className={`diff-content ${styles.diffContent}`}>{renderContent()}</td>
      </tr>
      {threadsAtLine && threadsAtLine.length > 0 && (
        <tr className={`diff-comment-row ${styles.diffCommentRow}`}>
          <td colSpan={colSpan}>
            <ExistingCommentWidget threads={threadsAtLine} replyContext={replyContext} />
          </td>
        </tr>
      )}
      {commentLineNum !== null && renderComposerForLine && (
        <ComposerSlot
          filePath={filePath}
          lineNumber={commentLineNum}
          colSpan={colSpan}
          render={renderComposerForLine}
        />
      )}
    </>
  );
}

type SplitRowKind = 'header' | 'paired' | 'context' | 'solo-delete' | 'solo-insert';

interface SplitDiffLineRowProps {
  kind: SplitRowKind;
  oldLineNum?: number | null;
  newLineNum?: number | null;
  oldText?: string;
  newText?: string;
  content?: string;
  filePath: string;
  isFilled?: boolean;
  onLineClick?: (anchor: InlineAnchor) => void;
}

function SplitDiffLineRow({
  kind,
  oldLineNum,
  newLineNum,
  oldText,
  newText,
  content,
  filePath,
  isFilled,
  onLineClick,
}: SplitDiffLineRowProps) {
  if (kind === 'header') {
    return (
      <tr className="diff-line diff-line--hunk-header">
        {/* SplitDiffLineRow is only emitted from renderSplitRows (split mode = 4 columns always);
            full-width rows in mode-shared code paths use the mode-aware `colSpan` constant instead. */}
        <td colSpan={4}>
          <span className={`diff-hunk-header ${styles.diffHunkHeader}`}>{content}</span>
        </td>
      </tr>
    );
  }

  if (kind === 'context') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: content ?? '',
      });
    };
    return (
      <tr className="diff-line diff-line--context" {...(isFilled ? { 'data-fill': 'true' } : {})}>
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td data-side="old" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {newLineNum != null && onLineClick ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${newLineNum}`}
              onClick={handleClick}
            >
              {newLineNum}
            </button>
          ) : (
            (newLineNum ?? '')
          )}
        </td>
        <td data-side="new" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
      </tr>
    );
  }

  if (kind === 'solo-delete') {
    return (
      <tr className="diff-line diff-line--delete" aria-label={`Removed line ${oldLineNum ?? '?'}`}>
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td data-side="old" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
        <td
          aria-hidden="true"
          className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew} ${styles.diffCellEmpty}`}
        ></td>
        <td
          aria-hidden="true"
          data-side="new"
          className={`diff-content ${styles.diffContent} ${styles.diffCellEmpty}`}
        ></td>
      </tr>
    );
  }

  if (kind === 'solo-insert') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: content ?? '',
      });
    };
    return (
      <tr className="diff-line diff-line--insert" aria-label={`Added line ${newLineNum ?? '?'}`}>
        <td
          aria-hidden="true"
          className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld} ${styles.diffCellEmpty}`}
        ></td>
        <td
          aria-hidden="true"
          data-side="old"
          className={`diff-content ${styles.diffContent} ${styles.diffCellEmpty}`}
        ></td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {newLineNum != null && onLineClick ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${newLineNum}`}
              onClick={handleClick}
            >
              {newLineNum}
            </button>
          ) : (
            (newLineNum ?? '')
          )}
        </td>
        <td data-side="new" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
      </tr>
    );
  }

  if (kind === 'paired') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: newText ?? '',
      });
    };
    return (
      <tr className="diff-line diff-line--paired">
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td data-side="old" className={`diff-content ${styles.diffContent}`}>
          <WordDiffOverlay oldText={oldText ?? ''} newText={newText ?? ''} type="delete" />
        </td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {newLineNum != null && onLineClick ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${newLineNum}`}
              onClick={handleClick}
            >
              {newLineNum}
            </button>
          ) : (
            (newLineNum ?? '')
          )}
        </td>
        <td data-side="new" className={`diff-content ${styles.diffContent}`}>
          <WordDiffOverlay oldText={oldText ?? ''} newText={newText ?? ''} type="insert" />
        </td>
      </tr>
    );
  }

  return null;
}

// A row that renders the composer iff the parent's renderComposerForLine
// returns non-null for the given line. Avoids putting `if (active)` logic
// into DiffPane itself.
function ComposerSlot({
  filePath,
  lineNumber,
  colSpan,
  render,
}: {
  filePath: string;
  lineNumber: number;
  colSpan: number;
  render: (filePath: string, lineNumber: number) => React.ReactNode;
}) {
  const node = render(filePath, lineNumber);
  if (!node) return null;
  return (
    <tr className={`diff-composer-row ${styles.diffComposerRow}`}>
      <td colSpan={colSpan}>{node}</td>
    </tr>
  );
}
