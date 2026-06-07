import { Skeleton, SkeletonText } from '../Skeleton';
import styles from './PrDetailSkeleton.module.css';

/**
 * Body skeleton mirroring OverviewTab: AI summary card, description, the 4 stats
 * tiles, and a conversation stub. Deliberately renders NO button placeholder
 * (the review-files CTA) — buttons stay out of the loading state as a rule. Root
 * keeps the `pr-detail-skeleton` test id so the #180 freshness regression test
 * can assert its absence on background reload.
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
    </div>
  );
}
