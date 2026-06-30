import { useEffect, useState } from 'react';
import { formatAge } from '../../../utils/relativeTime';
import styles from './StalePill.module.css';

export const STALE_LABEL_THRESHOLD_MS = 30 * 60_000; // #619 owner-chosen, tunable
const TICK_MS = 60_000;

interface StalePillProps {
  lastRefreshedAt: string;
}

/**
 * #619 — "Updated <age>" pill, shown only when the data is older than STALE_LABEL_THRESHOLD_MS.
 * Purely VISUAL: the audible stale-onset cue is owned by InboxPage's page-level
 * `inbox-stale-status` live region (Task 9). Round-3 DES-2/R3-6: a second `aria-live` here would
 * fire in the SAME render tick as the page region for one condition, which screen readers queue
 * or drop inconsistently — so the pill carries no live region of its own.
 */
export function StalePill({ lastRefreshedAt }: StalePillProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), TICK_MS); // re-evaluate age + threshold while idle
    return () => clearInterval(id);
  }, []);

  const ageMs = Date.now() - new Date(lastRefreshedAt).getTime();
  const show = Number.isFinite(ageMs) && ageMs > STALE_LABEL_THRESHOLD_MS;

  return (
    <div className={styles.slot}>
      {show && (
        <span className={styles.pill} data-testid="inbox-stale-pill">
          Updated {formatAge(lastRefreshedAt)}
        </span>
      )}
    </div>
  );
}
