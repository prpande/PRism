import { useEffect, useState } from 'react';
import { getActivity } from '../api/activity';
import type { ActivityResponse } from '../api/types';

const POLL_MS = 90_000;

export interface UseActivityResult {
  data: ActivityResponse | null;
  isLoading: boolean;
  error: Error | null;
}

// Polls /api/activity every ~90s. Retains last-good data across a failed poll
// (no error flash on a transient blip), mirroring usePrDetail's preservation rule.
// Last-good retention works because the error path skips setData — no ref needed.
// Tab-hidden visibility-pause remains future work: P2 landed the 3-call fan-out
// (events + notifications + subscriptions) but not the pause optimization itself.
//
// #507 — `enabled` gates the fetch so the hook can be hoisted into InboxPage and
// called unconditionally (Rules of Hooks) while preserving the #300/#283
// no-fetch-when-hidden guarantee: when the rail is hidden (toggle off or narrow
// viewport) the request never fires. Hoisting lets /api/activity start in parallel
// with the inbox fetch on cold load instead of after the rail mounts.
export function useActivity(enabled = true): UseActivityResult {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Hidden: no request, and settle out of the initial loading state so a later
      // enable shows the skeleton (set below) rather than a stale spinner.
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);

    const poll = async () => {
      try {
        const next = await getActivity();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Do NOT call setData — preserve last-good state on error.
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return { data, isLoading, error };
}
