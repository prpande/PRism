import { Skeleton, SkeletonText } from '../Skeleton';
import styles from './PrDetailSkeleton.module.css';

/**
 * Body skeleton mirroring OverviewTab: AI summary card, description, the 4 stats
 * tiles, a conversation stub, and the review-files CTA. Root keeps the
 * `pr-detail-skeleton` test id so the #180 freshness regression test can assert
 * its absence on background reload.
 */
export function PrDetailSkeleton() {
  return (
    <div
      className={styles.skeleton}
      data-testid="pr-detail-skeleton"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading PR…</span>
      <Skeleton className={styles.summary} height={84} />
      <SkeletonText lines={6} />
      <div className={styles.tiles}>
        <Skeleton height={64} />
        <Skeleton height={64} />
        <Skeleton height={64} />
        <Skeleton height={64} />
      </div>
      <div className={styles.conversation}>
        <Skeleton circle width={32} />
        <SkeletonText lines={2} widths={['80%', '50%']} />
      </div>
      <Skeleton width={160} height={36} />
    </div>
  );
}
