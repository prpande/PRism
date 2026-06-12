import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi } from '../api/inbox';
import { ApiError } from '../api/client';
import type { InboxResponse } from '../api/types';

const RETRY_DELAYS_MS = [0, 500, 1500];

export function useInbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Monotonic generation guard (the pattern every sibling data hook carries —
  // usePrDetail/useActivity/useFileDiff/useSubmitInFlight). Each reload() bumps it
  // and captures its own value; a slower in-flight attempt — e.g. an older 503-retry
  // chain that a banner-triggered reload overlapped — checks isCurrent() across every
  // await and bails instead of clobbering fresher data. The unmount cleanup bumps it
  // too, so a late resolve can't setState on an unmounted component.
  const generationRef = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    setIsLoading(true);
    let lastError: unknown = null;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      if (!isCurrent()) return;
      try {
        const next = await inboxApi.get();
        if (!isCurrent()) return;
        setData(next);
        setError(null);
        setIsLoading(false);
        return;
      } catch (e) {
        if (!isCurrent()) return;
        lastError = e;
        // Only retry on 503 (backend initializing); all other errors fail fast.
        if (!(e instanceof ApiError) || e.status !== 503) break;
      }
    }
    if (!isCurrent()) return;
    setError(lastError);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      // Invalidate any in-flight attempt so its late resolve can't setState after
      // unmount (its captured generation no longer matches). Intentionally mutating
      // the ref's CURRENT value at cleanup time — copying it to a local (as the rule
      // suggests for node refs) would defeat the invalidation.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate generation bump on unmount; not a stale node-ref hazard (#330)
      generationRef.current++;
    };
  }, [reload]);
  return { data, error, isLoading, reload };
}
