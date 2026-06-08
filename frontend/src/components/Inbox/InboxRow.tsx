import { useNavigate } from 'react-router-dom';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { formatAge } from '../../utils/relativeTime';
import { Avatar } from '../Avatar/Avatar';
import { DiffBar } from './DiffBar';
import styles from './InboxRow.module.css';

interface Props {
  pr: PrInboxItem;
  enrichment?: InboxItemEnrichment;
  showCategoryChip: boolean;
  maxDiff: number;
  showRepo?: boolean;
}

export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff, showRepo = true }: Props) {
  const navigate = useNavigate();
  const { addTab } = useOpenTabs();
  const doneState: 'merged' | 'closed' | null =
    pr.mergedAt != null ? 'merged' : pr.closedAt != null ? 'closed' : null;
  const isDone = doneState != null;
  // "Unread" = the PR's current head differs from the head the user last saw
  // (#121/#122). This covers both a never-opened PR (lastViewedHeadSha == null,
  // so it can't equal headSha → unread) and one whose head moved since it was
  // last viewed. Seen + unchanged → not unread. Done PRs are terminal, never
  // flagged. Commits-only: the inbox payload has no latest-comment id, so
  // comment-unread isn't derivable here.
  const hasUnseenActivity = !isDone && pr.lastViewedHeadSha !== pr.headSha;
  const onClick = () => {
    addTab(pr.reference, pr.title);
    navigate(`/pr/${pr.reference.owner}/${pr.reference.repo}/${pr.reference.number}`);
  };

  // The accent bar is a purely visual ::before (invisible to AT); carry the same
  // cue in the label so screen readers get it (replaces the removed "New" text).
  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}`
    : `${pr.title} · ${pr.repo} · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }`;

  return (
    <button
      className={styles.row}
      data-unread={hasUnseenActivity ? 'true' : 'false'}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <span className={styles.status}>
        {!isDone && pr.ci === 'failing' ? (
          <span
            className={`${styles.dot} ${styles.dotDanger}`}
            role="img"
            aria-label="CI: failing"
            title="CI failing"
          />
        ) : !isDone && pr.ci === 'pending' ? (
          <span
            className={`${styles.dot} ${styles.dotPending}`}
            role="img"
            aria-label="CI: pending"
            title="CI pending"
          />
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
        )}
      </span>
      <span className={styles.main}>
        <span className={styles.title}>{pr.title}</span>
        <span className={styles.meta}>
          {showRepo && (
            <>
              <span className={styles.mono}>{pr.repo}</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
          <span className={styles.author} data-testid="inbox-author">
            <Avatar src={pr.avatarUrl} login={pr.author} size="sm" />
            <span>{pr.author}</span>
          </span>
          <span className={styles.dotsep}>·</span>
          <span className={styles.mono}>iter {pr.iterationNumber}</span>
          <span className={styles.dotsep}>·</span>
          <span>{formatAge(pr.updatedAt)}</span>
        </span>
      </span>
      <span className={styles.tail}>
        {doneState === 'merged' && (
          <span className={`${styles.stateBadge} ${styles.badgeMerged}`}>Merged</span>
        )}
        {doneState === 'closed' && (
          <span className={`${styles.stateBadge} ${styles.badgeClosed}`}>Closed</span>
        )}
        {showCategoryChip && enrichment?.categoryChip && (
          <span className={styles.chip}>{enrichment.categoryChip}</span>
        )}
        <DiffBar additions={pr.additions} deletions={pr.deletions} max={maxDiff} />
        <span className={styles.counts}>
          <span className={styles.add}>+{pr.additions}</span>
          <span className={styles.del}>−{pr.deletions}</span>
        </span>
        {pr.commentCount > 0 && <span className={styles.comments}>{pr.commentCount}</span>}
      </span>
    </button>
  );
}
