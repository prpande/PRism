import { memo } from 'react';
import type { ReviewThreadDto, DiffLine } from '../../../../api/types';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import type {
  ExistingCommentWidgetReplyContext,
  ThreadCollapseControl,
} from './ExistingCommentWidget';
import { normalizeEol, type SyntaxTokenMaps } from '../../../../hooks/useSyntaxTokens';
import { HighlightedLine } from '../../../Markdown/HighlightedLine';
import { MergedPairedContent, tokensFor } from './MergedPairedContent';
import { NewGutterCell, CommentWidgetRow, ComposerSlot, makeGutterClick } from './gutter';
import styles from './DiffPane.module.css';

interface DiffLineRowProps {
  line: DiffLine;
  pair: DiffLine | null;
  threadsAtLine: ReviewThreadDto[] | undefined;
  filePath: string;
  colSpan: number;
  syntax: SyntaxTokenMaps;
  isFilled?: boolean;
  dataChangeStart?: number;
  dataChangeEnd?: number;
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  // #327 Task 12 — this row's composer-content stamp
  // (`c:${draftId}:${anyOtherDraftsStaged}` for the open composer plus
  // placeholder clientIds; null when this line hosts neither),
  // derived per row by UnifiedDiffBody from activeComposerKey. Declared ONLY so
  // it participates in React.memo's shallow compare: renderComposerForLine is
  // identity-stable, so this changing is what re-renders the row (and its
  // ComposerSlot) when composer content arrives at, changes on, or leaves this
  // line — a stamp rather than a boolean because post-now swaps the composer
  // for an optimistic placeholder at the SAME line, which presence alone would
  // miss. The render body deliberately does not read it — ComposerSlot already
  // asks renderComposerForLine for the line's content on every row render.
  composerStamp?: string | null;
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
}

// #670: memoized so an unrelated DiffPane re-render (e.g. a change-nav scroll, which
// re-renders DiffPane but not its FilesTab parent — leaving the callback props
// referentially stable) does not reconcile every <tr>. Default shallow compare is
// correct: the row is a pure function of its props (handleClick/renderContent close
// only over props; threadsAtLine is stabilized by the threadsByLine useMemo in
// DiffPane).
export const DiffLineRow = memo(function DiffLineRow({
  line,
  pair,
  threadsAtLine,
  filePath,
  colSpan,
  syntax,
  isFilled,
  dataChangeStart,
  dataChangeEnd,
  onLineClick,
  renderComposerForLine,
  replyContext,
  collapse,
}: DiffLineRowProps) {
  const isAnchored = (threadsAtLine?.length ?? 0) > 0;
  const rowClass = `diff-line diff-line--${line.type}${isAnchored ? ' diff-line--commented' : ''}`;

  const renderContent = () => {
    if (line.type === 'hunk-header') {
      return <span className={`diff-hunk-header ${styles.diffHunkHeader}`}>{line.content}</span>;
    }

    if ((line.type === 'insert' || line.type === 'delete') && pair) {
      const oldText = line.type === 'delete' ? line.content : pair.content;
      const newText = line.type === 'insert' ? line.content : pair.content;
      const side = line.type === 'delete' ? 'old' : 'new';
      return (
        <MergedPairedContent
          syntax={syntax}
          side={side}
          lineNum={line.type === 'delete' ? line.oldLineNum : line.newLineNum}
          oldText={oldText}
          newText={newText}
        />
      );
    }

    // Side-aware: a unified delete line has no newLineNum — its tokens live on
    // the old side (mapHunks('old') keys delete lines by oldLineNum). Context &
    // insert lines use the new side. (The plan used 'new' only; that left
    // unified solo-delete lines as plaintext.)
    const side = line.type === 'delete' ? 'old' : 'new';
    const toks = tokensFor(syntax, side, side === 'old' ? line.oldLineNum : line.newLineNum);
    return <HighlightedLine spans={toks} fallback={normalizeEol(line.content)} />;
  };

  // Scope: only right-side (insert/context) clicks open the composer. The
  // right-side anchor is now iteration-aware — FilesTab stamps the displayed
  // range's afterSha (anchorShaForRange, #723). Left-side (deleted-line)
  // commenting stays deferred: it needs the mirror resolution (the displayed
  // range's beforeSha) plus this gate flipping to allow line.type === 'delete'
  // (see docs/specs/2026-06-01-real-side-by-side-diff-rendering-deferrals.md).
  const commentLineNum = line.newLineNum;
  const canComment =
    onLineClick && commentLineNum !== null && (line.type === 'insert' || line.type === 'context');

  const handleClick = canComment
    ? makeGutterClick({
        onLineClick,
        filePath,
        lineNumber: commentLineNum,
        side: 'right',
        anchoredLineContent: line.content,
      })
    : undefined;

  return (
    <>
      <tr
        className={rowClass}
        {...(isFilled ? { 'data-fill': 'true' } : {})}
        data-change-start={dataChangeStart}
        data-change-end={dataChangeEnd}
      >
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {line.oldLineNum ?? ''}
        </td>
        <NewGutterCell lineNum={line.newLineNum} onComment={handleClick} />
        {/* The hunk-header row's <td> inherits the scaled font-size from the
            row, but its visible content is a fixed-size `.diffHunkHeader` span —
            so a font-size assertion against this cell would pass for the wrong
            reason. Skip the testid on hunk-header so e2e only measures real
            code cells (#135 review). */}
        <td
          className={`diff-content ${styles.diffContent}`}
          {...(line.type !== 'hunk-header' ? { 'data-testid': 'diff-code-line' } : {})}
        >
          {renderContent()}
        </td>
      </tr>
      {threadsAtLine && threadsAtLine.length > 0 && (
        <CommentWidgetRow
          threads={threadsAtLine}
          colSpan={colSpan}
          replyContext={replyContext}
          collapse={collapse}
        />
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
});
