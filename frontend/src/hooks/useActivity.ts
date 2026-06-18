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
//
// #359 — module-scoped last-good cache. The in-mount last-good retention above only
// survives a failed poll within ONE mount; navigating away from the inbox unmounts
// InboxPage, so component-local state reset to null/loading and the rail re-flashed
// its skeleton on every return. Module scope is what survives that unmount/remount:
// on re-navigation the rail seeds instantly from `cachedActivity` and revalidates in
// place. The FETCH stays gated by `enabled`, so this is NOT an app-root provider —
// that would fetch on every page, not just the inbox-only rail. The cache lives for
// the app session; the 90s poll + on-mount revalidate keep it fresh.
let cachedActivity: ActivityResponse | null = null;

// Test-only: clear the module cache between cases so last-good doesn't bleed across
// renders (production never resets it — it persists for the session by design).
export function __resetActivityCacheForTests(): void {
  cachedActivity = null;
}

export function useActivity(enabled = true): UseActivityResult {
  const [data, setData] = useState<ActivityResponse | null>(cachedActivity);
  // Skeleton only on a genuine first load: enabled AND nothing cached yet. With a
  // cache present the rail renders last-good immediately (no skeleton flash).
  const [isLoading, setIsLoading] = useState(enabled && cachedActivity === null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Hidden: no request, and settle out of the initial loading state so a later
      // enable shows the skeleton (only when uncached) rather than a stale spinner.
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    // Show the skeleton only when there's no cached data to render under it;
    // otherwise this is a background revalidate and the rail keeps last-good.
    if (cachedActivity === null) setIsLoading(true);

    const poll = async () => {
      try {
        const next = await getActivity();
        if (cancelled) return;
        cachedActivity = next;
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
