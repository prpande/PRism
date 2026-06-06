import { useEffect, useRef, useState } from 'react';
import { useStreamHealth } from '../../hooks/useStreamHealth';
import styles from './StreamHealthSnackbar.module.css';

export function StreamHealthSnackbar() {
  const { healthy, retry } = useStreamHealth();
  const [dismissed, setDismissed] = useState(false);
  const wasHealthy = useRef(healthy);

  // Reset the dismiss flag on every healthy → unhealthy edge (a fresh outage).
  useEffect(() => {
    if (wasHealthy.current && !healthy) setDismissed(false);
    wasHealthy.current = healthy;
  }, [healthy]);

  if (healthy || dismissed) return null;

  return (
    <div className={styles.snackbar} role="status" aria-live="polite">
      <span className={styles.message}>Connection lost — reconnecting</span>
      <button type="button" className={styles.retry} onClick={retry}>
        Retry now
      </button>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
