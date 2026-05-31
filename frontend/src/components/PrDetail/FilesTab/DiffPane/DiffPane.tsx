import { useMemo } from 'react';
import type {
  FileChange,
  ReviewThreadDto,
  DraftSide,
  PrReference,
  HunkAnnotation,
} from '../../../../api/types';
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
}

interface DiffLine {
  type: 'context' | 'insert' | 'delete' | 'hunk-header';
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

function parseHunkLines(body: string): DiffLine[] {
  const rawLines = body.split('\n');
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const match = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(raw);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      lines.push({ type: 'hunk-header', content: raw, oldLineNum: null, newLineNum: null });
    } else if (raw.startsWith('+')) {
      lines.push({ type: 'insert', content: raw.slice(1), oldLineNum: null, newLineNum: newLine });
      newLine++;
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'delete', content: raw.slice(1), oldLineNum: oldLine, newLineNum: null });
      oldLine++;
    } else if (raw.startsWith(' ')) {
      lines.push({
        type: 'context',
        content: raw.slice(1),
        oldLineNum: oldLine,
        newLineNum: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return lines;
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

  const allLines: DiffLine[] = [];
  for (const hunk of file.hunks) {
    allLines.push(...parseHunkLines(hunk.body));
  }

  const isSplit = diffMode === 'side-by-side';
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

      if (line.type === 'hunk-header') {
        hunkCounter += 1;
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
    }
    return rows;
  }

  function renderSplitRows(): React.ReactNode[] {
    const path = selectedPath ?? '';
    const rows: React.ReactNode[] = [];
    let hunkCounter = -1;
    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];

      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="header"
            content={line.content}
            filePath={path}
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
        continue;
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
            onLineClick={onLineClick}
          />,
        );
        continue;
      }

      // Modification kinds (delete/insert) added in Task 3 — content rows are
      // placeholder-deferred. Threads that happen to anchor on these lines are
      // preserved so comment widgets remain visible in split mode.
      const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
      const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
      if (threadsAtLine && threadsAtLine.length > 0) {
        rows.push(
          <tr key={`thread-${idx}`} className={`diff-comment-row ${styles.diffCommentRow}`}>
            <td colSpan={colSpan}>
              <ExistingCommentWidget threads={threadsAtLine} replyContext={replyContext} />
            </td>
          </tr>,
        );
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
      <div className={`diff-pane-body ${styles.diffPaneBody}`}>
        <table className={`diff-table ${styles.diffTable}`}>
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
      <tr className={rowClass}>
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
  onLineClick?: (anchor: InlineAnchor) => void;
}

function SplitDiffLineRow({
  kind,
  oldLineNum,
  newLineNum,
  content,
  filePath,
  onLineClick,
}: SplitDiffLineRowProps) {
  if (kind === 'header') {
    return (
      <tr className="diff-line diff-line--hunk-header">
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
      <tr className="diff-line diff-line--context">
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

  // Modification kinds (paired, solo-delete, solo-insert) added in Task 3.
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
