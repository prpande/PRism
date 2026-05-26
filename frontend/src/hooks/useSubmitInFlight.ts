import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

export interface SubmitInFlightState {
  inFlight: boolean;
  prRef: string | null;
}

// Tracks GET /api/submit/in-flight to disable the AuthSection Replace link while a submit
// holds the SubmitLockRegistry (spec § 3.1). Event-driven, not interval-polled: fetches
// once on mount and refetches on every `prism-state-changed` window event so the link
// re-enables the instant the lock clears — no manual page refresh needed. The event is
// dispatched by api/events.ts's SSE bridge (state-changed → window event).
//
// Tolerant by design: a transient 4xx/5xx is swallowed and the prior state is retained.
// The guard is best-effort UX hardening, not a security boundary; the backend rejects an
// /api/auth/replace POST taken during a held submit lock with a 409. If the SSE stream
// is permanently broken (no state-changed events delivered), the link stays in its last-
// observed state until the next page navigation re-mounts the hook — spec § 3.1 accepts
// this trade for the PoC ("permanent disable preferable to stale-enabled link that 409s").
export function useSubmitInFlight(): SubmitInFlightState {
  const [state, setState] = useState<SubmitInFlightState>({ inFlight: false, prRef: null });

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const resp = await apiClient.get<SubmitInFlightState>('/api/submit/in-flight');
        if (!cancelled) setState(resp);
      } catch {
        // Reset to fail-open ({inFlight:false}) on error rather than retaining
        // stale state. If a prior fetch saw inFlight=true and the post-lock-release
        // refetch 503s (server restart, transient network), retaining the prior
        // state would leave the Replace link stuck aria-disabled with no future
        // event to clear it (the submit is already done; no state-changed will
        // fire). Fail-open is safe: the backend's /api/auth/replace 409 still
        // enforces correctness on the actual replace attempt.
        if (!cancelled) setState({ inFlight: false, prRef: null });
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
