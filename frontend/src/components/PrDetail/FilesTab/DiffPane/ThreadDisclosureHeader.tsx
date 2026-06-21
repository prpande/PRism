import { Avatar } from '../../../Avatar/Avatar';
import { Badge } from '../../../Badge/Badge';
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
  lineNumber: number;
}

function countLabel(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 comment' : `${n} comments`;
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
  const count = countLabel(commentCount);
  const resolvedBadge = isResolved ? <Badge aria-label="Resolved thread">Resolved</Badge> : null;

  return (
    <button
      type="button"
      className={styles.header}
      data-testid="thread-disclosure"
      data-collapsed={collapsed}
      aria-expanded={!collapsed}
      aria-controls={bodyId}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} thread on ${filePath} line ${lineNumber}`}
      onClick={onToggle}
    >
      <svg className={styles.chevron} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M6 4l4 4-4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {collapsed ? (
        <>
          {author != null && <Avatar src={avatarUrl} login={author} size="sm" />}
          {author != null && <span className={styles.author}>{author}</span>}
          {snippet ? (
            <span className={styles.snippet} data-testid="thread-snippet" title={snippet}>
              {snippet}
            </span>
          ) : (
            <span className={styles.spacer} />
          )}
          {count && <Badge className={styles.pill}>{count}</Badge>}
          {resolvedBadge}
        </>
      ) : (
        <>
          <span className={styles.spacer} />
          {resolvedBadge}
        </>
      )}
    </button>
  );
}
