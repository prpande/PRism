// CommentCard.tsx
import { Avatar } from '../../Avatar/Avatar';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import styles from './CommentCard.module.css';

export type CommentDensity = 'comfortable' | 'compact';

export interface CommentCardProps {
  author: string;
  // Optional to match IssueCommentDto/ReviewCommentDto (`avatarUrl?: string | null`)
  // — the Overview test fixtures omit it, so a non-optional type breaks `tsc -b`.
  avatarUrl?: string | null;
  createdAt: string;
  body: string;
  density?: CommentDensity;
  /** Caller-composed slot pinned to the band's right edge (e.g. a Resolved tag). */
  bandEnd?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

// Renders ONE comment. Owns band + body + density only — resolved state, the
// rail, and stacking are the caller's composition (never a density branch here).
export function CommentCard({
  author,
  avatarUrl,
  createdAt,
  body,
  density = 'comfortable',
  bandEnd,
  className,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: CommentCardProps) {
  return (
    <article
      className={`${styles.card} ${className ?? ''}`}
      data-density={density}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      <header className={styles.band} data-testid="pr-comment-meta">
        <Avatar src={avatarUrl} login={author} size={density === 'compact' ? 'sm' : 'md'} />
        <span className={styles.author}>{author}</span>
        <time className={styles.time} dateTime={createdAt}>
          {new Date(createdAt).toLocaleDateString()}
        </time>
        {bandEnd != null && <span className={styles.bandEnd}>{bandEnd}</span>}
      </header>
      <div className={styles.body}>
        <MarkdownRenderer source={body} />
      </div>
    </article>
  );
}
