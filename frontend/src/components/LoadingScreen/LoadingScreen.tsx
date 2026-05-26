import { useEffect, useState } from 'react';
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
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  return (
    <div className={styles.screen} role="status" aria-busy="true" aria-live="polite">
      <img src="/prism-logo.png" alt="" aria-hidden="true" className={styles.watermark} />
      <div className={styles.center}>
        <img
          src="/prism-logo.png"
          alt=""
          aria-hidden="true"
          className={timedOut ? styles.logoStill : styles.pulseLogo}
        />
        <span className={styles.label}>{timedOut ? timeoutLabel : label}</span>
        {timedOut && (
          <button type="button" onClick={() => window.location.reload()} className={styles.reload}>
            Reload
          </button>
        )}
      </div>
    </div>
  );
}
