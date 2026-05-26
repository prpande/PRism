import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

export interface SubmitInFlightState {
  inFlight: boolean;
  prRef: string | null;
}

// Polls GET /api/submit/in-flight to disable the AuthSection Replace link while a submit
// holds the SubmitLockRegistry (spec § 3.1). Refetches on the `prism-state-changed` window
// event so the link re-enables the instant the lock clears — no manual page refresh needed.
// The event is dispatched by api/events.ts's SSE bridge (state-changed → window event).
//
// Tolerant by design: a transient 4xx/5xx is swallowed and the prior state is retained.
// The guard is best-effort UX hardening, not a security boundary; the backend rejects an
// /api/auth/replace POST taken during a held submit lock with a 409.
export function useSubmitInFlight(): SubmitInFlightState {
  const [state, setState] = useState<SubmitInFlightState>({ inFlight: false, prRef: null });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const resp = await apiClient.get<SubmitInFlightState>('/api/submit/in-flight');
        if (!cancelled) setState(resp);
      } catch {
        /* tolerated; best-effort guard */
      }
    };
    void fetchOnce();
    const handler = () => {
      void fetchOnce();
    };
    window.addEventListener('prism-state-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('prism-state-changed', handler);
    };
  }, []);

  return state;
}
