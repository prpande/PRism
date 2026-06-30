import { useEffect, useRef, useState } from 'react';
import { formatAge } from '../../../utils/relativeTime';
import styles from './StalePill.module.css';

export const STALE_LABEL_THRESHOLD_MS = 30 * 60_000; // #619 owner-chosen, tunable
const TICK_MS = 60_000;

interface StalePillProps {
  lastRefreshedAt: string;
}

/**
 * #619 — "Updated <age>" pill, shown only when the data is older than STALE_LABEL_THRESHOLD_MS.
 * Reserve-space: the container is always in the DOM at constant height (empty when hidden) so its
 * appearance/disappearance never reflows the toolbar. Announces its text once on threshold entry.
 */
export function StalePill({ lastRefreshedAt }: StalePillProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), TICK_MS); // re-evaluate age + threshold while idle
    return () => clearInterval(id);
  }, []);

  const ageMs = Date.now() - new Date(lastRefreshedAt).getTime();
  const show = Number.isFinite(ageMs) && ageMs > STALE_LABEL_THRESHOLD_MS;

  // Round-1 DES-2: announce via a PERSISTENTLY-MOUNTED live region whose text is set in an EFFECT on
  // the hidden→shown edge — NOT by toggling aria-live on a conditionally-mounted span or mutating a ref
  // during render (both fail under React strict-mode double-invoke and across AT engines). Mirrors the
  // InboxPage stale-onset pattern (Task 9).
  const [announceText, setAnnounceText] = useState('');
  const wasShown = useRef(false);
  useEffect(() => {
    if (show && !wasShown.current)
      setAnnounceText(`Inbox last updated ${formatAge(lastRefreshedAt)}`);
    wasShown.current = show;
  }, [show, lastRefreshedAt]);

  return (
    <div className={styles.slot} data-reserved="true">
      {/* Always-mounted sr-only live region — the announcement channel, separate from the visible pill.
          Uses the GLOBAL `sr-only` utility (which pins top:0;left:0), NOT a module class, and the .slot
          below sets position:relative — together they keep the abspos region clipped INSIDE the slot
          instead of escaping to the page and extending scroll height (round-2 DES-2; #197 /
          reference_sr_only_abspos_page_scroll). Mirrors Task 9's `className="sr-only"`. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announceText}
      </span>
      {show && (
        <span className={styles.pill} data-testid="inbox-stale-pill">
          Updated {formatAge(lastRefreshedAt)}
        </span>
      )}
    </div>
  );
}
