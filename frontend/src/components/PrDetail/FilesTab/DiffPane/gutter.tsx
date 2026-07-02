import styles from './DiffPane.module.css';

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
