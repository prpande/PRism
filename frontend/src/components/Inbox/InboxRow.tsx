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
  grouped?: boolean;
}

export function InboxRow({
  pr,
  enrichment,
  showCategoryChip,
  maxDiff,
  showRepo = true,
  grouped = false,
}: Props) {
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
  const ciSuffix =
    !isDone && pr.ci === 'failing'
      ? ' · CI failing'
      : !isDone && pr.ci === 'pending'
        ? ' · CI pending'
        : '';

  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}`
    : `${pr.title} · ${pr.repo} · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}`;

  return (
    <button
      className={styles.row}
      data-unread={hasUnseenActivity ? 'true' : 'false'}
      data-grouped={grouped ? 'true' : 'false'}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <span className={styles.status}>
        {!isDone && pr.ci === 'failing' ? (
          <span
            className={`${styles.dot} ${styles.dotFailing}`}
            title="CI failing"
            aria-hidden="true"
          />
        ) : !isDone && pr.ci === 'pending' ? (
          <span
            className={`${styles.dot} ${styles.dotPending}`}
            title="CI pending"
            aria-hidden="true"
          />
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
        )}
      </span>
      <span className={styles.main}>
        <span className={styles.title} title={pr.title}>
          {pr.title}
        </span>
        <span className={styles.meta}>
          {doneState === 'merged' && (
            <>
              <span className={`${styles.stateBadge} ${styles.badgeMerged}`}>Merged</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
          {doneState === 'closed' && (
            <>
              <span className={`${styles.stateBadge} ${styles.badgeClosed}`}>Closed</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
          {showCategoryChip && enrichment?.categoryChip && (
            <>
              <span className={styles.chip}>{enrichment.categoryChip}</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
          {showRepo && (
            <>
              <span className={styles.mono}>{pr.repo}</span>
              <span className={styles.dotsep}>·</span>
            </>
          )}
          <span className={styles.author} data-testid="inbox-author">
            <Avatar src={pr.avatarUrl} login={pr.author} size="sm" />
            <span className={styles.authorName}>{pr.author}</span>
          </span>
          <span className={styles.dotsep}>·</span>
          <span className={styles.mono}>iter {pr.iterationNumber}</span>
          <span className={styles.dotsep}>·</span>
          <span>{formatAge(pr.updatedAt)}</span>
        </span>
      </span>
      <span className={styles.tail}>
        <span className={styles.metrics}>
          <span className={styles.diffSlot}>
            <DiffBar additions={pr.additions} deletions={pr.deletions} max={maxDiff} />
          </span>
          <span className={`${styles.counts} ${styles.countsSlot}`}>
            <span className={styles.add}>+{pr.additions}</span>
            <span className={styles.del}>−{pr.deletions}</span>
          </span>
          <span className={styles.commentSlot}>
            {pr.commentCount > 0 && <span className={styles.comments}>{pr.commentCount}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}
