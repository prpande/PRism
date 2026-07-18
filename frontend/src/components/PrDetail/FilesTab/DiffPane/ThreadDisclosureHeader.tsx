import { Avatar } from '../../../Avatar/Avatar';
import styles from './ThreadDisclosureHeader.module.css';

export interface ThreadDisclosureHeaderProps {
  collapsed: boolean;
  onToggle: () => void;
  bodyId: string;
  author?: string;
  avatarUrl?: string | null;
  snippet?: string;
  commentCount: number;
  isResolved: boolean;
  filePath: string;
  lineNumber: number | null;
}

// File-tree chevron (15px / stroke 1.75) so the disclosure caret matches the
// file-tree arrow's weight and size.
function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Octicon comment-16 — the same glyph the inbox uses for its comment-count
// metric. Accent-tinted (via .countIcon) so the count reads as a metric, not
// plain text.
function CommentGlyph() {
  return (
    <svg
      className={styles.countIcon}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1ZM1.5 2.75v8.5a.25.25 0 0 0 .25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Z" />
    </svg>
  );
}

export function ThreadDisclosureHeader({
  collapsed,
  onToggle,
  bodyId,
  author,
  avatarUrl,
  snippet,
  commentCount,
  isResolved,
  filePath,
  lineNumber,
}: ThreadDisclosureHeaderProps) {
  const location = lineNumber == null ? filePath : `${filePath} line ${lineNumber}`;
  const ariaLabel = `${collapsed ? 'Expand' : 'Collapse'} thread on ${location}`;
  const sharedButtonProps = {
    type: 'button' as const,
    'data-testid': 'thread-disclosure',
    'data-collapsed': collapsed,
    'aria-expanded': !collapsed,
    'aria-controls': bodyId,
    'aria-label': ariaLabel,
    onClick: onToggle,
  };

  // The resolved pill shows in BOTH states — it stays visible after a resolved
  // thread is expanded, not just on the collapsed summary.
  const resolvedPill = isResolved ? (
    <span className={`chip chip-success ${styles.resolvedBadge}`} aria-label="Resolved thread">
      Resolved
    </span>
  ) : null;

  // Expanded: a thin header with the small square toggle on the left and the
  // resolved pill on the right; the thread cards render below (in the body).
  // Only the toggle button is interactive (hover); the header and pill are not.
  if (!collapsed) {
    return (
      <div className={styles.expandedHeader}>
        <button {...sharedButtonProps} className={styles.toggle}>
          <Chevron />
        </button>
        <span className={styles.spacer} />
        {resolvedPill}
      </div>
    );
  }

  // Collapsed: the whole single-line summary is the click-to-expand target — a
  // standout card that hover-highlights. The leading chevron sits in a square
  // frame so the toggle reads the same in both states.
  return (
    <button {...sharedButtonProps} className={styles.collapsed}>
      <span className={styles.chevronBox}>
        <Chevron />
      </span>
      {author != null && (
        <>
          <Avatar src={avatarUrl} login={author} size="sm" />
          <span className={styles.author}>{author}</span>
        </>
      )}
      {snippet ? (
        <span className={styles.snippet} data-testid="thread-snippet" title={snippet}>
          {snippet}
        </span>
      ) : (
        <span className={styles.spacer} />
      )}
      {commentCount > 0 && (
        <span
          className={styles.count}
          aria-label={`${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`}
        >
          <CommentGlyph />
          {commentCount}
        </span>
      )}
      {resolvedPill}
    </button>
  );
}
