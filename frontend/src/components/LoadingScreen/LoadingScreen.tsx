import { useEffect, useState } from 'react';
import { Spinner } from '../Spinner';
import styles from './LoadingScreen.module.css';

interface Props {
  label?: string;
  timeoutMs?: number;
  timeoutLabel?: string;
}

export function LoadingScreen({
  label = 'Loading…',
  timeoutMs = 10000,
  timeoutLabel = 'Taking longer than expected — check the terminal output.',
}: Props) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setTimedOut(false);
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  return (
    // aria-busy toggles off when the timeout state stabilizes so ATs announce
    // the new "Taking longer…" + Reload content via the role=status live region.
    // Per ARIA: aria-busy=true tells ATs to defer announcements within the
    // region, which we want during the indeterminate Loading… phase but not
    // after the content settles.
    <div className={styles.screen} role="status" aria-busy={!timedOut}>
      <div className={styles.center}>
        {/* Static brand mark — the activity cue is the spinner below, not a
            pulsing logo. The spinner is decorative so this region stays the
            single live region announcing the Loading… → timeout transition. */}
        <img src="/prism-logo.png" alt="" aria-hidden="true" className={styles.logo} />
        {!timedOut && <Spinner size="lg" decorative />}
        <span className={styles.label}>{timedOut ? timeoutLabel : label}</span>
        {timedOut && (
          // Compose the global `.btn .btn-secondary` utility classes from
          // src/styles/tokens.css so the Reload button picks up the design
          // system's border / background / focus ring instead of inheriting
          // the global button reset's bare appearance.
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-secondary"
          >
            Reload
          </button>
        )}
      </div>
    </div>
  );
}
