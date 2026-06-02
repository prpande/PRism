import { useNavigate } from 'react-router-dom';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { formatAge } from '../../utils/relativeTime';
import { DiffBar } from './DiffBar';
import styles from './InboxRow.module.css';

interface Props {
  pr: PrInboxItem;
  enrichment?: InboxItemEnrichment;
  showCategoryChip: boolean;
  maxDiff: number;
}

function freshness(updatedAt: string): 'fresh' | 'today' | 'older' {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (ageMs < 30 * 60 * 1000) return 'fresh';
  if (ageMs < 24 * 60 * 60 * 1000) return 'today';
  return 'older';
}

export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff }: Props) {
  const navigate = useNavigate();
  const { addTab } = useOpenTabs();
  const doneState: 'merged' | 'closed' | null =
    pr.mergedAt != null ? 'merged' : pr.closedAt != null ? 'closed' : null;
  const isDone = doneState != null;
  // Done PRs are not urgent — neutralise freshness highlighting.
  const fr = isDone ? 'older' : freshness(pr.updatedAt);
  const isFirstVisit = pr.lastViewedHeadSha == null;
  const onClick = () => {
    addTab(pr.reference, pr.title);
    navigate(`/pr/${pr.reference.owner}/${pr.reference.repo}/${pr.reference.number}`);
  };

  const frClass =
    fr === 'fresh' ? styles.rowFresh : fr === 'today' ? styles.rowToday : styles.rowOlder;

  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}`
    : `${pr.title} · ${pr.repo} · iteration ${pr.iterationNumber}`;

  return (
    <button className={`${styles.row} ${frClass}`} onClick={onClick} aria-label={ariaLabel}>
      <span className={styles.status}>
        {!isDone && pr.ci === 'failing' ? (
          <span className={`${styles.dot} ${styles.dotDanger}`} title="CI failing" />
        ) : !isDone && isFirstVisit ? (
          <span className={styles.newChip}>New</span>
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
        )}
      </span>
      <span className={styles.main}>
        <span className={styles.title}>{pr.title}</span>
        <span className={styles.meta}>
          <span className={styles.mono}>{pr.repo}</span>
          <span className={styles.dotsep}>·</span>
          <span>{pr.author}</span>
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
