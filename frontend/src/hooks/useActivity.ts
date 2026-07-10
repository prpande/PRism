import { useEffect, useState } from 'react';
import { getActivity } from '../api/activity';
import type { ActivityResponse } from '../api/types';

const POLL_MS = 90_000;

const isVisible = () => document.visibilityState === 'visible';

export interface UseActivityResult {
  data: ActivityResponse | null;
  isLoading: boolean;
  error: Error | null;
}

// Polls /api/activity every ~90s. Retains last-good data across a failed poll
// (no error flash on a transient blip), mirroring usePrDetail's preservation rule.
// Last-good retention works because the error path skips setData — no ref needed.
//
// #732 — the poll is gated on document visibility, mirroring InboxPage's #717 backstop:
// a hidden tab issues zero requests (this endpoint is a real 3-call GitHub fan-out, not a
// localhost snapshot), and returning to visible fires one immediate catch-up rather than
// waiting out the remaining cadence.
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
    // #619 — one-shot flag: scoped to this effect closure so it resets on each mount.
    // Prevents an unbounded fetch loop when the backend keeps returning stale:true —
    // we do NOT rely on the backend flipping stale→false as the terminator (DES-4).
    let immediateRefetchFired = false;
    // #732 — single-flight, mirroring useCheckRuns. A hide/show cycle during a slow poll would
    // otherwise dispatch a second concurrent request (the resume catch-up keys off the interval
    // being unarmed, not off a request being pending); both write the module cache, so an
    // out-of-order response could clobber a newer one.
    let inFlight = false;
    // Show the skeleton only when there's no cached data to render under it;
    // otherwise this is a background revalidate and the rail keeps last-good. Mounting
    // while hidden therefore holds the skeleton until the first foreground, since
    // isLoading settles only in poll()'s finally.
    if (cachedActivity === null) setIsLoading(true);

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getActivity();
        if (cancelled) return;
        cachedActivity = next;
        setData(next);
        setError(null);
        if (next.stale && !immediateRefetchFired && isVisible()) {
          // #619 — the rehydrated feed is stale; nudge an immediate live fetch rather
          // than waiting ~90s. The backend seeds an expired TTL so this refetch is a
          // real GitHub read. Round-1 DES-4: gate on an explicit one-shot flag (scoped
          // to this effect closure) so a backend that returns stale:true twice cannot
          // trigger an unbounded fetch loop — don't rely on backend behavior as the
          // loop terminator.
          //
          // #732 — isVisible() because stop() cannot cancel an in-flight request: a poll
          // issued while visible can land stale after the tab hides. Spending the one-shot
          // only when the nudge fires leaves it available to the resume poll.
          immediateRefetchFired = true;
          queueMicrotask(() => {
            if (!cancelled) void poll();
          });
        }
      } catch (e) {
        if (cancelled) return;
        // Do NOT call setData — preserve last-good state on error.
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        // Cleared before the #619 microtask runs (queueMicrotask drains after this
        // synchronous continuation), so the nudge is never suppressed by single-flight.
        inFlight = false;
        if (!cancelled) setIsLoading(false);
      }
    };

    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      id ??= setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (id !== undefined) {
        clearInterval(id);
        id = undefined;
      }
    };
    const onVisibility = () => {
      if (!isVisible()) {
        stop();
        return;
      }
      // Catch up exactly once per resume: only when the interval was actually paused. A
      // redundant 'visible' event (browsers emit these on some focus cycles) leaves id
      // armed, so it fires no extra poll.
      if (id === undefined) void poll();
      start();
    };

    if (isVisible()) {
      void poll();
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [enabled]);

  return { data, isLoading, error };
}
