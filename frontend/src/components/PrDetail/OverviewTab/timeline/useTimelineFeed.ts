import { useCallback, useEffect, useRef, useState } from 'react';
import { getTimelinePage } from '../../../../api/timeline';
import type { PrReference, TimelineEvent, TimelinePage } from '../../../../api/types';
import { prRefKey } from '../../../../api/types';

type Status = 'loading' | 'error' | 'ready';

function mergeById(primary: TimelineEvent[], incoming: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set(primary.map((e) => e.id));
  return [...primary, ...incoming.filter((e) => !seen.has(e.id))];
}

export function useTimelineFeed(prRef: PrReference, opts: { prUpdatedSignal: number }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const eventsRef = useRef<TimelineEvent[]>([]);
  eventsRef.current = events; // latest events for refetchNewest's fresh-diff (avoids setState-in-updater)
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const key = prRefKey(prRef);

  // Shared first-page-load-and-set-state block, used by both the initial mount/prRef-change effect
  // and the error-state `reload` retry. Behavior matches both call sites exactly: the initial load
  // passes an AbortController signal and guards `!signal.aborted` before setting error (so an
  // unmount/prRef-change cancel doesn't flip a stale hook instance to 'error'); `reload` calls
  // without a signal and always resets status on failure.
  const loadFirstPage = useCallback(
    (signal?: AbortSignal) => {
      setStatus('loading');
      getTimelinePage(prRef, null, signal)
        .then((page: TimelinePage) => {
          setEvents(page.events);
          cursorRef.current = page.olderCursor;
          setHasOlder(page.hasOlder);
          setStatus('ready');
        })
        .catch(() => {
          if (!signal || !signal.aborted) setStatus('error');
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // Initial load (and reload on PR change).
  useEffect(() => {
    const ac = new AbortController();
    loadFirstPage(ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Explicit retry for the error state. Distinct from loadOlder (which early-returns when !hasOlder,
  // so it is a no-op after an initial-load failure) — this re-runs the first-page load and resets status.
  const reload = useCallback(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    getTimelinePage(prRef, cursorRef.current)
      .then((page) => {
        setEvents((prev) => mergeById(prev, page.events));
        cursorRef.current = page.olderCursor;
        setHasOlder(page.hasOlder);
      })
      .finally(() => setLoadingOlder(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasOlder, loadingOlder]);

  const refetchNewest = useCallback(() => {
    getTimelinePage(prRef, null)
      .then((page) => {
        // Prepend genuinely-new events; keep already-loaded older ones. Compute fresh against the ref
        // (not inside the setEvents updater) so we can announce what arrived without a render-phase setState.
        const known = new Set(eventsRef.current.map((e) => e.id));
        const fresh = page.events.filter((e) => !known.has(e.id));
        if (fresh.length === 0) return;
        const top = fresh[0];
        // Announce WHAT arrived, not a raw total — and only on this live path (loadOlder must not announce).
        setLiveAnnouncement(
          fresh.length === 1 && top.actor.login
            ? `${top.actor.login} ${top.verb}`
            : `${fresh.length} new updates`,
        );
        setEvents((prev) => [...fresh, ...prev]);
      })
      .catch(() => {
        /* live-refresh is best-effort; keep the current feed on failure */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Live-refresh: the parent bumps prUpdatedSignal on each pr-updated frame for this PR.
  const firstSignal = useRef(true);
  // PrDetailView is reused across PR navigation (not remounted — see usePrDetail.ts), so this ref
  // survives a PR change. Reset it whenever the PR `key` changes so a freshly-navigated-to PR gets
  // the same "skip the first fire" treatment a real mount gets — otherwise a stale `false` guard
  // from the previous PR lets refetchNewest fire alongside loadFirstPage's own initial request for
  // the new PR, doubling the request and risking a liveAnnouncement computed against stale events.
  // Declared before the signal effect below so it applies within the same commit as a key change
  // (refetchNewest's identity also changes with `key`, which is what re-triggers that effect).
  useEffect(() => {
    firstSignal.current = true;
  }, [key]);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    refetchNewest();
  }, [opts.prUpdatedSignal, refetchNewest]);

  return {
    events,
    status,
    hasOlder,
    loadOlder,
    loadingOlder,
    refetchNewest,
    reload,
    liveAnnouncement,
  };
}
