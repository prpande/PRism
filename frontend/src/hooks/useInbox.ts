import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi } from '../api/inbox';
import { ApiError } from '../api/client';
import type { InboxResponse } from '../api/types';

const RETRY_DELAYS_MS = [0, 500, 1500];

export function useInbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Tracks any reload() attempt in-flight (true while the retry loop is running),
  // regardless of whether `data` already exists. Distinct from the cold `isLoading`
  // flag that the skeleton uses: `isLoading && !data` → skeleton; `isFetching` →
  // loaded-branch loading bar. This lets a stale rehydrated inbox (data present,
  // stale:true) show its content while a revalidation request is in flight, and lets
  // the bar turn OFF once the retry loop exits — even if the network is down and the
  // data stays stale. Keyed to reload(), NOT to the `stale` flag.
  const [isFetching, setIsFetching] = useState(false);
  // Monotonic generation guard. Sibling data hooks (usePrDetail/useActivity/
  // useFileDiff) use an effect-scoped `cancelled` boolean; this hook needs a ref-keyed
  // generation instead because `reload` is ALSO called imperatively (banner retry /
  // manual refresh) outside the mount effect — a closure flag can't invalidate a later
  // overlapping reload mid-503-retry. Each reload() bumps the ref and captures its own
  // value; a slower in-flight attempt checks isCurrent() across every await and bails
  // instead of clobbering fresher data. The unmount cleanup bumps it too, so a late
  // resolve can't setState on an unmounted component.
  const generationRef = useRef(0);

  const reload = useCallback(async () => {
    console.log('[DBG-INBOX-RELOAD] reload() called → GET /api/inbox');
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    setIsLoading(true);
    setIsFetching(true);
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
        setIsFetching(false);
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
    setIsFetching(false);
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
  return { data, error, isLoading, isFetching, reload };
}
