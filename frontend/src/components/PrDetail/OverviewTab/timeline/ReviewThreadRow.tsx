import { useState } from 'react';
import { Avatar } from '../../../Avatar/Avatar';
import { InboxCaret } from '../../../Inbox/InboxCaret';
import { CommentCard } from '../../Comment/CommentCard';
import type { ReviewThreadDto } from '../../../../api/types';
import styles from './ReviewThreadRow.module.css';

export function ReviewThreadRow({ thread }: { thread: ReviewThreadDto }) {
  const [expanded, setExpanded] = useState(false);

  const fileLevel = thread.subjectType === 'FILE';
  // Outdated keys on isOutdated OR a null line — NOT lineNumber alone. Real data has
  // isOutdated:true threads with a non-null line (BFF#202, real data — the spec's 1:1 bullet
  // notwithstanding); D6 says
  // those get no click-through, so they must read as Outdated, not as an anchored line chip.
  const outdated = !fileLevel && (thread.isOutdated === true || thread.lineNumber == null);
  const anchored = !fileLevel && !outdated; // non-outdated LINE thread with a real lineNumber

  const first = thread.comments[0];
  const snippet = first?.body ?? '';
  const replyCount = thread.comments.length - 1;
  const wasLabel =
    outdated && thread.originalLine != null
      ? thread.originalStartLine != null
        ? `was L${thread.originalStartLine}–${thread.originalLine}`
        : `was L${thread.originalLine}`
      : null;

  // The disclosure button carries an explicit aria-label, which overrides ALL descendant text for
  // the accessible name — so the collapsed row's chips (line / outdated / file-level / resolved /
  // reply count) never reach a screen reader and every row on a file sounds identical. Fold that
  // status into the label. Keep the `Review thread on {path}` prefix verbatim so the existing unit
  // (`/thread/i`) and e2e (`/thread on {path}/i`) locators still resolve.
  const rowLabel =
    `Review thread on ${thread.filePath}` +
    (anchored
      ? `, line ${thread.lineNumber}`
      : outdated
        ? ', outdated'
        : fileLevel
          ? ', file-level'
          : '') +
    (replyCount > 0 ? `, ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : '') +
    (thread.isResolved ? ', resolved' : '');

  return (
    <li className={styles.threadRow}>
      <div className={styles.rowLine}>
        <button
          type="button"
          className={styles.rowHeader}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="timeline-thread-row"
          aria-label={rowLabel}
        >
          <InboxCaret open={expanded} />
          {fileLevel ? (
            <span className={styles.fileChip}>File</span>
          ) : anchored ? (
            <span className={styles.lineChip}>
              {thread.filePath}:{thread.lineNumber}
            </span>
          ) : (
            <span className={styles.outdatedBadge}>Outdated</span>
          )}
          <Avatar src={first?.avatarUrl ?? null} login={first?.author ?? ''} size="sm" />
          <span className={styles.author}>{first?.author}</span>
          <span className={styles.snippet}>{snippet}</span>
          {replyCount > 0 && (
            <span className={styles.replyCount}>
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </span>
          )}
          {thread.isResolved && <span className={styles.resolvedChip}>Resolved</span>}
        </button>
        {/* PR 2 (#774) adds a sibling "View in diff" button here, anchored threads only. */}
      </div>
      {expanded && (
        <div className={styles.panel}>
          {wasLabel && <p className={styles.wasLabel}>{wasLabel}</p>}
          {thread.diffHunk && (
            <pre className={styles.hunk} data-testid="timeline-thread-hunk">
              {thread.diffHunk}
            </pre>
          )}
          <ul className={styles.commentStack}>
            {thread.comments.map((c) => (
              <li key={c.commentId}>
                <CommentCard
                  density="compact"
                  avatarSize="sm"
                  author={c.author}
                  avatarUrl={c.avatarUrl ?? undefined}
                  createdAt={c.createdAt}
                  body={c.body}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
