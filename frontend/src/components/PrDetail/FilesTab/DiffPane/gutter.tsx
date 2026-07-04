import type { ReviewThreadDto } from '../../../../api/types';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import {
  ExistingCommentWidget,
  type ExistingCommentWidgetReplyContext,
  type ThreadCollapseControl,
} from './ExistingCommentWidget';
import styles from './DiffPane.module.css';

// Shared builder for the gutter comment-affordance click handlers. All four
// diff-row click sites build the same anchor shape; they differ only in which
// text becomes anchoredLineContent (and the row-level gates that decide
// whether a handler exists at all — those stay at the call sites). Returns
// undefined when no onLineClick is bound so callers can pass the result
// straight to NewGutterCell's optional onComment.
export function makeGutterClick({
  onLineClick,
  filePath,
  lineNumber,
  side,
  anchoredLineContent,
}: {
  onLineClick: ((anchor: InlineAnchor) => void) | undefined;
  filePath: string;
  lineNumber: number;
  side: InlineAnchor['side'];
  anchoredLineContent: string;
}): (() => void) | undefined {
  if (!onLineClick) return undefined;
  return () => {
    onLineClick({
      filePath,
      lineNumber,
      side,
      // anchoredSha is left empty here — DiffPane has no PR-detail context.
      // FilesTab.openComposerAt fills it in with the after-side commit of the
      // displayed range (anchorShaForRange, #723): the iteration's afterSha on
      // an older-iteration view, the PR head on "All changes". Only right-side
      // clicks are enabled, so that after-side SHA is always a valid anchor.
      anchoredSha: '',
      anchoredLineContent,
    });
  };
}

// New-side gutter cell. #554: the line number is ALWAYS rendered as visible flow
// text; the comment affordance is an additive hover glyph (a filled, accent-colored
// comment bubble; its aria-label carries the line number, so the click contract
// that many e2e specs query by `name: /add comment on line N/` is unchanged).
// Previously the number lived *inside* the opacity-0 affordance button, so on
// all-insert (added) files — which have no old-side number — the entire gutter
// looked blank until hover.
export function NewGutterCell({
  lineNum,
  onComment,
}: {
  lineNum: number | null | undefined;
  onComment?: () => void;
}) {
  return (
    <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
      <span className={`diff-gutter-num ${styles.diffGutterNum}`}>{lineNum ?? ''}</span>
      {lineNum != null && onComment && (
        <button
          type="button"
          className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
          aria-label={`Add comment on line ${lineNum}`}
          onClick={onComment}
        >
          {/* Filled Octicon comment-16 (solid bubble), accent-colored via CSS.
              The aria-label carries the accessible name, so the glyph is hidden. */}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1Z" />
          </svg>
        </button>
      )}
    </td>
  );
}

// Full-width follow-up row hosting the ExistingCommentWidget for a line's
// review threads. Shared by the unified (DiffLineRow) and split (SplitDiffBody)
// emit sites so the wrapper markup stays identical.
export function CommentWidgetRow({
  threads,
  colSpan,
  replyContext,
  collapse,
}: {
  threads: ReviewThreadDto[];
  colSpan: number;
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
}) {
  return (
    <tr className={`diff-comment-row ${styles.diffCommentRow}`}>
      <td colSpan={colSpan}>
        <div className={styles.diffStickyViewport}>
          <ExistingCommentWidget
            threads={threads}
            replyContext={replyContext}
            collapse={collapse}
          />
        </div>
      </td>
    </tr>
  );
}

// A row that renders the composer iff the parent's renderComposerForLine
// returns non-null for the given line. Avoids putting `if (active)` logic
// into DiffPane itself.
export function ComposerSlot({
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
      <td colSpan={colSpan}>
        <div className={styles.diffStickyViewport}>{node}</div>
      </td>
    </tr>
  );
}
