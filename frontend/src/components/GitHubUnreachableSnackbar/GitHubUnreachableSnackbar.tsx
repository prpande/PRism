import { useEffect, useRef, useState } from 'react';
import { Snackbar } from '../Snackbar';

interface Props {
  failing: boolean; // GitHub looks unreachable (Option C: stale persisted past the watchdog window)
  onRetry: () => void;
  suppressed: boolean; // true when StreamHealthSnackbar (FE↔backend down) is visible
}

/**
 * #619 — non-blocking "Couldn't reach GitHub" pill on a sustained background-fetch failure. Modeled on
 * StreamHealthSnackbar: steady-state render, pinned through the episode, dismiss-once-per-episode,
 * suppressed under the more-fundamental backend-connection snackbar (shared fixed slot). Mutually
 * exclusive with the cold-load ErrorModal — mount this only when cached data is present (caller gates).
 */
export function GitHubUnreachableSnackbar({ failing, onRetry, suppressed }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const wasFailing = useRef(failing);
  useEffect(() => {
    if (!wasFailing.current && failing) setDismissed(false); // fresh failing edge re-shows
    wasFailing.current = failing;
  }, [failing]);

  if (!failing || dismissed || suppressed) return null;

  return (
    <Snackbar
      tone="warning"
      message="Couldn't reach GitHub — retrying"
      action={{ label: 'Retry now', onClick: onRetry }}
      onDismiss={() => setDismissed(true)}
      role="status"
      ariaLive="polite"
    />
  );
}
