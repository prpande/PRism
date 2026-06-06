import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { PrReference } from '../api/types';
import { useEventSource } from './useEventSource';

export interface ActivePrUpdates {
  hasUpdate: boolean;
  headShaChanged: boolean;
  commentCountDelta: number;
  isMerged: boolean;
  isClosed: boolean;
  clear(): void;
}

const initial = {
  hasUpdate: false,
  headShaChanged: false,
  commentCountDelta: 0,
  isMerged: false,
  isClosed: false,
};

export function useActivePrUpdates(prRef: PrReference): ActivePrUpdates {
  const stream = useEventSource();
  const [state, setState] = useState(initial);
  const refStr = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  useEffect(() => {
    if (!stream) return;
    // Reset aggregated state when prRef changes so banners don't leak across
    // PR navigations. useState(initial) only fires on first mount; without
    // this, navigating from PR A (with hasUpdate=true) to PR B inherits A's
    // banner until a new event arrives or clear() is called.
    setState(initial);
    let cancelled = false;
    // Tracks the most recent in-flight subscribe POST so the cleanup DELETE can
    // be chained to fire only AFTER it settles (#142). Without this, an unmount
    // during an in-flight POST fires the DELETE concurrently; if the DELETE
    // reaches the server first it is an idempotent no-op, and the later POST then
    // lands a dangling (subscriberId, prRef) subscription the ActivePrPoller keeps
    // servicing until the SSE connection itself drops. Initialized to a resolved
    // promise so an unmount before any POST issues still cleans up immediately
    // (the loop's `if (cancelled) return` guarantees no POST follows that DELETE).
    let lastSubscribePost: Promise<unknown> = Promise.resolve();

    const unsubscribe = stream.on('pr-updated', (event) => {
      if (event.prRef !== refStr) return;
      setState((s) => ({
        hasUpdate: true,
        headShaChanged: s.headShaChanged || event.headShaChanged,
        commentCountDelta: s.commentCountDelta + event.commentCountDelta,
        // Latched (once done, stays done). Backend guarantees isMerged/isClosed are
        // mutually exclusive per Task 15a; if both ever arrive, PrDetailPage prioritizes merged.
        isMerged: s.isMerged || event.isMerged,
        isClosed: s.isClosed || event.isClosed,
      }));
    });

    // Re-subscribes on every reconnect per spec § 7.4: the loop awaits the next
    // handshake, POSTs the subscription, then sleeps until the current
    // reconnect-signal aborts (watchdog stall or onerror-via-ping path).
    async function subscribeLoop() {
      while (!cancelled && stream) {
        try {
          await stream.subscriberId();
          if (cancelled) return;
          // Capture the POST promise synchronously (no await between the
          // cancelled-check and this assignment) so the cleanup closure always
          // sees the live POST it must order the DELETE behind.
          lastSubscribePost = apiClient.post('/api/events/subscriptions', { prRef: refStr });
          await lastSubscribePost;
        } catch {
          // Subscribe failure is non-fatal: cookie-keyed routing on the server still
          // delivers events. Silent — no observable impact in PoC scope.
        }

        const signal = stream.reconnectSignal();
        if (signal.aborted) continue;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }
    void subscribeLoop();

    return () => {
      cancelled = true;
      unsubscribe();
      // Order-guard (#142): chain the DELETE after the in-flight subscribe POST
      // settles so the server always observes POST→DELETE, never DELETE→POST.
      // A failed POST registered nothing, but we still issue the (idempotent)
      // DELETE to keep one cleanup path.
      void lastSubscribePost
        .catch(() => {
          // Swallow the POST rejection here; the DELETE below runs regardless.
        })
        .then(() =>
          apiClient.delete(`/api/events/subscriptions?prRef=${encodeURIComponent(refStr)}`),
        )
        .catch(() => {
          // Idempotent on the server; failure means nothing to clean up.
        });
    };
  }, [stream, refStr]);

  const clear = () => setState(initial);

  return { ...state, clear };
}
