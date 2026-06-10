import { Skeleton } from '../Skeleton';
import styles from './InboxSkeleton.module.css';

const SECTIONS = 3;
const ROWS_PER_SECTION = 3;

function Row() {
  return (
    <div className={styles.row} data-testid="inbox-skeleton-row">
      <Skeleton circle width={8} />
      <div className={styles.rowMain}>
        <Skeleton width="70%" height={12} />
        <Skeleton width="45%" height={10} />
      </div>
      <div className={styles.rowTail}>
        <Skeleton width={48} height={10} />
        <Skeleton width={28} height={10} />
      </div>
    </div>
  );
}

/**
 * Content-shaped inbox skeleton. Mirrors the paste-URL toolbar, section headers,
 * and InboxRow shape. `showRail` is supplied by InboxPage from the
 * inbox.showActivityRail preference (#137/#309) so the skeleton stays
 * presentational. Renders no buttons (loading state shows no clickable
 * affordances — same rule as PR-detail).
 */
export function InboxSkeleton({ showRail }: { showRail: boolean }) {
  return (
    <main className={styles.page} data-testid="inbox-skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading inbox…</span>
      <Skeleton width="100%" height={36} radius={8} />
      <div className={styles.grid} data-has-rail={showRail}>
        <div>
          {Array.from({ length: SECTIONS }, (_, s) => (
            <div key={s} className={styles.section} data-testid="inbox-skeleton-section">
              <div className={styles.sectionHeader}>
                <Skeleton width={12} height={12} radius={3} />
                <Skeleton width={140} height={12} />
                <Skeleton width={24} height={16} radius={8} />
              </div>
              {Array.from({ length: ROWS_PER_SECTION }, (_, r) => (
                <Row key={r} />
              ))}
            </div>
          ))}
        </div>
        {showRail && (
          <div className={styles.rail} data-testid="inbox-skeleton-rail">
            {/* P1: single Activity panel. The second (Watching) block returns in P2. */}
            <Skeleton height={120} radius={10} />
          </div>
        )}
      </div>
    </main>
  );
}
