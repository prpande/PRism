import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { PrReference } from '../api/types';
import { useEventSource } from './useEventSource';

export interface ActivePrUpdates {
  hasUpdate: boolean;
  headShaChanged: boolean;
  commentCountDelta: number;
  clear(): void;
}

const initial = { hasUpdate: false, headShaChanged: false, commentCountDelta: 0 };

export function useActivePrUpdates(prRef: PrReference): ActivePrUpdates {
  const stream = useEventSource();
  const [state, setState] = useState(initial);
  const refStr = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  useEffect(() => {
    if (!stream) return;
    let cancelled = false;

    const unsubscribe = stream.on('pr-updated', (event) => {
      if (event.prRef !== refStr) return;
      setState((s) => ({
        hasUpdate: true,
        headShaChanged: s.headShaChanged || event.headShaChanged,
        commentCountDelta: s.commentCountDelta + event.commentCountDelta,
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
          await apiClient.post('/api/events/subscriptions', { prRef: refStr });
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
      void apiClient
        .delete(`/api/events/subscriptions?prRef=${encodeURIComponent(refStr)}`)
        .catch(() => {
          // Idempotent on the server; failure means nothing to clean up.
        });
    };
  }, [stream, refStr]);

  const clear = () => setState(initial);

  return { ...state, clear };
}
