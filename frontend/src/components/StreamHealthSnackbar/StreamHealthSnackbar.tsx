import { useEffect, useRef, useState } from 'react';
import { useStreamHealth } from '../../hooks/useStreamHealth';
import { Snackbar } from '../Snackbar';

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
    <Snackbar
      tone="warning"
      message="Connection lost — reconnecting"
      action={{ label: 'Retry now', onClick: retry }}
      onDismiss={() => setDismissed(true)}
      role="status"
      ariaLive="polite"
    />
  );
}
