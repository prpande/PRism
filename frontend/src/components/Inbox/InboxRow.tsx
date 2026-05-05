import { useNavigate } from 'react-router-dom';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';
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

function formatAge(updatedAt: string): string {
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff }: Props) {
  const navigate = useNavigate();
  const fr = freshness(pr.updatedAt);
  const isFirstVisit = pr.lastViewedHeadSha == null;
  const onClick = () =>
    navigate(`/pr/${pr.reference.owner}/${pr.reference.repo}/${pr.reference.number}`);

  const frClass =
    fr === 'fresh' ? styles.rowFresh : fr === 'today' ? styles.rowToday : styles.rowOlder;

  return (
    <button className={`${styles.row} ${frClass}`} onClick={onClick}>
      <span className={styles.status}>
        {pr.ci === 'failing' ? (
          <span className={`${styles.dot} ${styles.dotDanger}`} title="CI failing" />
        ) : isFirstVisit ? (
          <span className={styles.newChip}>New</span>
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} />
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
          <span>{formatAge(pr.updatedAt)} ago</span>
        </span>
      </span>
      <span className={styles.tail}>
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
