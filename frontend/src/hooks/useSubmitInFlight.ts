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
// Fail-open on error: a transient 4xx/5xx resets state to `{inFlight:false,prRef:null}`.
// The guard is best-effort UX hardening, not a security boundary; the backend rejects an
// /api/auth/replace POST taken during a held submit lock with a 409, which is enforced
// regardless of what this hook reports. Resetting (rather than retaining the prior
// inFlight=true) avoids a stuck disabled-link state when the post-lock-release refetch
// fails and no future state-changed event will fire (the submit already completed).
// Spec § 3.1's "permanent disable preferable to stale-enabled" trade applies to a
// permanently-broken SSE stream where no event-driven refetch ever happens — not to
// transient single-request failures.
export function useSubmitInFlight(): SubmitInFlightState {
  const [state, setState] = useState<SubmitInFlightState>({ inFlight: false, prRef: null });

  useEffect(() => {
    let cancelled = false;
    // Fetch-generation counter (claude[bot] iter-5 F2): rapid prism-state-changed
    // events would otherwise let two in-flight fetches resolve out of order, with
    // the slower one winning by virtue of resolving last. A monotonically-increasing
    // generation stamp captured per fetch lets us discard any setState() from a
    // fetch that's been superseded by a newer one. Defends against the lock-
    // acquired-then-immediately-released case where two state-changed frames fire
    // back-to-back and the GET responses arrive in reverse order.
    let fetchGen = 0;
    const fetchOnce = async () => {
      const myGen = ++fetchGen;
      const isCurrent = () => !cancelled && myGen === fetchGen;
      try {
        const resp = await apiClient.get<SubmitInFlightState>('/api/submit/in-flight');
        if (isCurrent()) setState(resp);
      } catch {
        // Reset to fail-open ({inFlight:false}) on error rather than retaining
        // stale state. If a prior fetch saw inFlight=true and the post-lock-release
        // refetch 503s (server restart, transient network), retaining the prior
        // state would leave the Replace link stuck aria-disabled with no future
        // event to clear it (the submit is already done; no state-changed will
        // fire). Fail-open is safe: the backend's /api/auth/replace 409 still
        // enforces correctness on the actual replace attempt.
        if (isCurrent()) setState({ inFlight: false, prRef: null });
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
