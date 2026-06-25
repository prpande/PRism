// frontend/src/hooks/useCheckRuns.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCheckRuns } from '../api/checks';
import { ApiError } from '../api/client';
import type { CheckRun, DegradedReason, PrReference } from '../api/types';

const POLL_MS = 15_000;
const LATE_REGISTRATION_MS = 120_000; // ~2 min re-poll window on a still-empty list

export interface CheckRunsResult {
  status: 'idle' | 'loading' | 'ok' | 'empty' | 'error';
  degraded: DegradedReason;
  checks: CheckRun[];
  retry: () => void;
}

const isNonTerminal = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';

export function useCheckRuns(
  prRef: PrReference,
  headSha: string | undefined,
  active: boolean,
): CheckRunsResult {
  const [status, setStatus] = useState<CheckRunsResult['status']>('idle');
  const [degraded, setDegraded] = useState<DegradedReason>('none');
  const [checks, setChecks] = useState<CheckRun[]>([]);
  // useState nonce (NOT a ref) so retry() triggers an observable re-render and the
  // effect re-runs — mirrors the useFileFocusResult retryNonce precedent. A ref bump
  // would not re-run the effect (refs aren't reactive).
  const [retryNonce, setRetryNonce] = useState(0);

  // Series identity: the SHA whose checks the current `checks`/window belong to.
  // Owned by the polling effect only — there is NO second effect mutating these
  // (a separate headSha-reset effect would race the polling effect and null the
  // window before shouldKeepPolling reads it — adversarial/scope R1).
  const seriesShaRef = useRef<string | undefined>(undefined);
  const windowOpenedAtRef = useRef<number>(0);

  const refKey = `${prRef.owner}/${prRef.repo}/${prRef.number}`;
  // setStatus('loading') gives immediate feedback when retrying from the error screen
  // (a same-SHA retry does NOT hit the new-series 'loading' branch below). adversarial R2.
  const retry = useCallback(() => {
    setStatus('loading');
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const gateOpen = active && headSha != null && document.visibilityState === 'visible';
    if (!gateOpen) return;

    // New SHA series: clear the prior head's verdict so its green tick / failing
    // badge does NOT survive the Reload boundary (spec § Tab strip indicator), reset
    // the degraded banner so a prior head's auth/transient caption doesn't flash on the
    // new head (security R2), and (re)open the late-registration window. A same-SHA
    // re-run (active re-toggle or retry) preserves the last list (stale-while-revalidate).
    if (seriesShaRef.current !== headSha) {
      seriesShaRef.current = headSha;
      windowOpenedAtRef.current = Date.now();
      setChecks([]);
      setDegraded('none');
      setStatus('loading');
    }

    let cancelled = false;
    let inFlight = false; // single-flight, scoped to this effect run
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController(); // one controller per series; cleanup aborts it

    const shouldKeepPolling = (list: CheckRun[]): boolean => {
      if (list.some(isNonTerminal)) return true; // live work in progress
      if (list.length === 0) {
        // bounded late-registration re-poll, measured from THIS series' open time
        return Date.now() - windowOpenedAtRef.current < LATE_REGISTRATION_MS;
      }
      return false; // all terminal, ≥1 present → done
    };

    const tick = async () => {
      // Re-check the gate on every scheduled tick — a window blurred AFTER the effect
      // fired must stop polling (scope R1). The point-in-time gate above only covers
      // the first tick.
      if (document.visibilityState !== 'visible') return;
      if (inFlight) return; // single-flight: skip overlapping ticks
      inFlight = true;
      try {
        const res = await getCheckRuns(prRef, headSha!, ctrl.signal);
        if (cancelled || res.headSha !== headSha) return; // cross-series backstop
        setChecks(res.checks);
        setDegraded(res.degraded);
        setStatus(res.checks.length === 0 ? 'empty' : 'ok');
        if (shouldKeepPolling(res.checks)) {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        setDegraded(err instanceof ApiError && err.status === 403 ? 'auth' : 'transient');
        setStatus('error'); // stop the loop; retry() restarts via the nonce
      } finally {
        inFlight = false;
      }
    };

    void tick();

    // Resume on re-show. The tick() visibility guard STOPS the loop when the window is
    // hidden (it returns before rescheduling), but nothing re-runs the effect when the
    // window becomes visible again (visibilityState is not a dep). Without this listener
    // the loop stays frozen on a stale glyph after the user switches windows mid-run —
    // the exact "watch CI finish" use case (adversarial R2). One tick() on re-show
    // restarts the loop if the series is still live; single-flight + shouldKeepPolling
    // make a no-op-on-terminal safe.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !cancelled) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
      ctrl.abort(); // cross-series race guard: an in-flight old-SHA fetch is aborted
    };
    // refKey is the stable string proxy for prRef's primitives (owner/repo/number):
    // keying on it (not the prRef object) means a new prRef object with identical
    // fields does NOT spuriously reset the polling series. Same pattern as
    // useActivePrUpdates. prRef itself is read inside tick() but only via those primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refKey captures prRef's identity
  }, [active, headSha, refKey, retryNonce]);

  return { status, degraded, checks, retry };
}
