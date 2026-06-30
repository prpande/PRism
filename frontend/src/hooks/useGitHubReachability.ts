import { useEffect, useRef, useState } from 'react';

export const STALE_FAILING_AFTER_MS = 30_000; // #619 — how long stale must persist before we call it "unreachable"

/**
 * #619 (Option C) — FE-only GitHub-reachability heuristic. A rehydrated snapshot is `stale:true` until a
 * revalidation succeeds; if GitHub is unreachable the revalidation can't succeed, so `stale` stays true.
 * If it persists past STALE_FAILING_AFTER_MS we surface the snackbar. Clears the instant `stale` goes
 * false (a successful revalidation). Does NOT cover mid-session outages (already-fresh data is stale:false)
 * — that's deferred to the backend signal in #684.
 */
export function useGitHubReachability(stale: boolean): { failing: boolean } {
  const [failing, setFailing] = useState(false);
  // Mirror `failing` into a ref so the arm-guard reads the latest value WITHOUT `failing` being an
  // effect dep — keeping it in deps re-runs the effect once per stale-onset (timer fires → setFailing
  // → effect re-runs → guard blocks re-arm → no-op). The ref drops that spurious cycle.
  const failingRef = useRef(failing);
  failingRef.current = failing;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (stale) {
      if (timer.current === null && !failingRef.current) {
        timer.current = setTimeout(() => {
          setFailing(true);
          timer.current = null;
        }, STALE_FAILING_AFTER_MS);
      }
    } else {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setFailing(false);
    }
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [stale]);
  return { failing };
}
