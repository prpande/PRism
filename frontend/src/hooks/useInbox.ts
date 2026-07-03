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
  // True while a loud reload()'s retry loop is running. The silent revalidate() below defers to
  // it (a reload publishes fresher data and owns the loading flags), and — unlike the generation
  // bump — this flag lets revalidate coordinate WITHOUT cancelling the reload.
  const reloadInFlightRef = useRef(false);

  const reload = useCallback(async () => {
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    reloadInFlightRef.current = true;
    setIsLoading(true);
    setIsFetching(true);
    try {
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
    } finally {
      // Clear the in-flight flag only if we're still current; a fresher reload that superseded
      // us (bumped the generation) owns the flag and clears it on its own completion.
      if (isCurrent()) reloadInFlightRef.current = false;
    }
  }, []);

  // #713 — silent background revalidation for the poll-while-visible backstop. Unlike
  // reload(), it touches NO loading flags (so it can't flicker the loading bar every tick),
  // swallows failures keeping the current data, and does a single attempt (no 503 retry loop —
  // the next tick retries). Shares generationRef with reload() so a poll and a reload can't
  // clobber each other's fresher result. Its sole job is to guarantee the inbox eventually
  // re-fetches after a return-to-inbox whose nonce refetch was missed by a concurrent-render
  // timing race (the #704/#713 flake) — no fixed-cadence poller otherwise exists, and
  // mark-viewed emits no `inbox-updated` SSE frame.
  //
  // Unchanged-guard: skip setData when the payload is byte-identical to the last one this hook
  // stored, so an idle poll (the common case — nothing changed since the last fetch) does NOT
  // hand every row a fresh object reference and re-render the whole list, which would defeat
  // the #671 row memoization. Only revalidate() feeds this ref (reload() does not stringify —
  // a redundant re-render on the first poll tick after a reload is negligible and not worth
  // the hash there).
  const lastSerializedRef = useRef<string | null>(null);
  const revalidate = useCallback(async () => {
    // Defer to a loud reload() if one is running — it publishes fresher data and owns the
    // loading flags. Bumping generationRef here (as reload does) would CANCEL that in-flight
    // reload mid-retry and strand its isFetching/isLoading flags (revalidate never clears
    // them), leaving the loading bar stuck. So READ the generation, never bump it.
    if (reloadInFlightRef.current) return;
    const generation = generationRef.current;
    try {
      const next = await inboxApi.get();
      // Bail if a reload started (or the hook unmounted) while our GET was in flight — that
      // newer request owns the data now.
      if (generation !== generationRef.current || reloadInFlightRef.current) return;
      const serialized = JSON.stringify(next);
      if (serialized === lastSerializedRef.current) return; // nothing changed → no re-render
      lastSerializedRef.current = serialized;
      setData(next);
      setError(null);
    } catch {
      // Silent: keep current data; the next tick (or a manual refresh) retries.
    }
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
  return { data, error, isLoading, isFetching, reload, revalidate };
}
