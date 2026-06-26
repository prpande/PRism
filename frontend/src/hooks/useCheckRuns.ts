// frontend/src/hooks/useCheckRuns.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCheckRuns } from '../api/checks';
import { ApiError } from '../api/client';
import type { CheckRun, DegradedReason, PrReference } from '../api/types';

const POLL_MS = 15_000;
const LATE_REGISTRATION_MS = 120_000; // ~2 min re-poll window on a still-empty list
// Bounded WALL-CLOCK deadline (from arm time) that keeps the loop alive after a rerequest so
// the re-run's check is picked up even on an all-terminal list. NOT visible-time and NOT
// re-armed on focus: the loop is frozen while hidden anyway, and a fixed deadline guarantees
// the watch terminates regardless of focus-toggling (a visible-time re-arm could be pushed out
// indefinitely by alt-tabbing → button hung "Re-running…" forever, violating AC#3). Tunable:
// long enough for a rerequested run to appear on a cold runner. 90s is the default.
const RERUN_WATCH_MS = 90_000;

export interface CheckRunsResult {
  status: 'idle' | 'loading' | 'ok' | 'empty' | 'error';
  degraded: DegradedReason;
  checks: CheckRun[];
  retry: () => void;
  // The three rerun members are OPTIONAL even though the hook ALWAYS returns them.
  // CheckRunsResult is carried by PrDetailContextValue, which ~10 unrelated test files build
  // inline with an idle `checks` stub for tabs that never touch rerun. Required members would
  // force a mechanical edit in every one for zero behavioural reason. Optional confines the
  // change to the hook + the single consumer (CheckDetail, which null-guards). These are
  // internal result members, NOT a wire field — unlike CheckRun.checkRunId, which stays required.
  refetch?: () => void; // off-timer poll, no loading flash
  armRerunWatch?: (checkRunId: number) => void; // keep polling for a rerequested check
  rerunPendingFor?: number | null; // which checkRunId is being watched (reactive)
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
  const [refetchNonce, setRefetchNonce] = useState(0); // drives an off-timer poll
  const [rerunPendingFor, setRerunPendingFor] = useState<number | null>(null); // reactive watch flag

  // Series identity: the SHA whose checks the current `checks`/window belong to.
  const seriesShaRef = useRef<string | undefined>(undefined);
  const windowOpenedAtRef = useRef<number>(0);
  // Latest list + whether THIS series ever fetched successfully — read in the tick
  // catch block, which can't see fresh `checks` state.
  const checksRef = useRef<CheckRun[]>([]);
  const hadSuccessRef = useRef(false);
  // Rerun-watch state read inside the tick closure (refs, fresh across renders).
  const watchedIdRef = useRef<number | null>(null);
  const watchUntilRef = useRef<number>(0);

  const refKey = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  const retry = useCallback(() => {
    setStatus('loading');
    setRetryNonce((n) => n + 1);
  }, []);

  // Off-timer poll that preserves the list (no setStatus('loading')).
  const refetch = useCallback(() => {
    setRefetchNonce((n) => n + 1);
  }, []);

  // Arm a watch on a specific check so the loop stays alive after a rerequest. The deadline is
  // a fixed wall-clock instant from NOW and is never extended (see RERUN_WATCH_MS).
  const armRerunWatch = useCallback((checkRunId: number) => {
    watchedIdRef.current = checkRunId;
    watchUntilRef.current = Date.now() + RERUN_WATCH_MS;
    setRerunPendingFor(checkRunId);
    setRefetchNonce((n) => n + 1); // kick an immediate poll
  }, []);

  useEffect(() => {
    const gateOpen = active && headSha != null && document.visibilityState === 'visible';
    if (!gateOpen) return;

    // New SHA series: clear the prior head's verdict, reset the degraded banner, (re)open the
    // late-registration window, and drop any in-flight rerun-watch (its checkRunId belongs to
    // the old series). A same-SHA re-run preserves the last list (stale-while-revalidate).
    if (seriesShaRef.current !== headSha) {
      seriesShaRef.current = headSha;
      windowOpenedAtRef.current = Date.now();
      setChecks([]);
      checksRef.current = [];
      hadSuccessRef.current = false;
      setDegraded('none');
      setStatus('loading');
      watchedIdRef.current = null;
      watchUntilRef.current = 0;
      setRerunPendingFor(null);
    }

    let cancelled = false;
    let inFlight = false; // single-flight, scoped to this effect run
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();

    const shouldKeepPolling = (list: CheckRun[]): boolean => {
      // A live rerun-watch keeps the loop alive even when all checks are terminal.
      if (watchedIdRef.current != null && Date.now() < watchUntilRef.current) return true;
      if (list.some(isNonTerminal)) return true; // live work in progress
      if (list.length === 0) {
        // bounded late-registration re-poll, measured from THIS series' open time
        return Date.now() - windowOpenedAtRef.current < LATE_REGISTRATION_MS;
      }
      return false; // all terminal, ≥1 present → done
    };

    // Clear the watch when the watched check transitions OR the window expires. The
    // transition-clear (same id flips non-terminal) is BEST-EFFORT: a GitHub Actions rerequest
    // commonly emits a NEW check-run id while the original id stays terminal, so `watched` may
    // never go non-terminal. The wall-clock expiry is the REAL guarantee that "Re-running…"
    // clears; the re-run's new in-progress row is still surfaced by normal polling.
    const updateRerunWatch = (list: CheckRun[]) => {
      if (watchedIdRef.current == null) return;
      const watched = list.find((c) => c.checkRunId === watchedIdRef.current);
      const transitioned = watched != null && isNonTerminal(watched);
      if (transitioned || Date.now() >= watchUntilRef.current) {
        watchedIdRef.current = null;
        watchUntilRef.current = 0;
        setRerunPendingFor(null);
      }
    };

    const tick = async () => {
      // Re-check the gate on every scheduled tick — a window blurred AFTER the effect
      // fired must stop polling. The point-in-time gate above only covers the first tick.
      if (document.visibilityState !== 'visible') return;
      if (inFlight) return; // single-flight: skip overlapping ticks
      inFlight = true;
      try {
        const res = await getCheckRuns(prRef, headSha!, ctrl.signal);
        if (cancelled || res.headSha !== headSha) return; // cross-series backstop
        setChecks(res.checks);
        checksRef.current = res.checks;
        hadSuccessRef.current = true;
        setDegraded(res.degraded);
        setStatus(res.checks.length === 0 ? 'empty' : 'ok');
        updateRerunWatch(res.checks);
        if (shouldKeepPolling(res.checks)) {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        // 401/403 from PRism's own endpoint = auth (mirrors the reader's DegradedFor);
        // anything else is transient.
        setDegraded(
          err instanceof ApiError && (err.status === 401 || err.status === 403)
            ? 'auth'
            : 'transient',
        );
        // Expire the rerun-watch on a FAILING tick too. Without this, a poll that throws while
        // crossing the watch-window boundary never runs the window-expiry clear; the watch then
        // stays armed, shouldKeepPolling can return false, the loop stops, and rerunPendingFor is
        // stuck non-null → the button hangs "Re-running…" forever (AC#3). updateRerunWatch over
        // the stale list won't clear early but DOES clear once the window has elapsed.
        updateRerunWatch(checksRef.current);
        if (!hadSuccessRef.current) {
          // Cold series — nothing cached to fall back on. Surface the error screen.
          setStatus('error');
          // The loop stops here without the window necessarily having elapsed; drop any armed
          // watch so rerunPendingFor can't be left stuck (defensive — unreachable today because
          // the Re-run button only renders when status==='ok', which forces hadSuccessRef true
          // before a watch can be armed; this guards a future refactor).
          watchedIdRef.current = null;
          watchUntilRef.current = 0;
          setRerunPendingFor(null);
        } else {
          // Stale-while-revalidate: keep the last-known list on screen and keep polling so a
          // transient blip self-heals without a manual Retry.
          setStatus(checksRef.current.length === 0 ? 'empty' : 'ok');
          if (shouldKeepPolling(checksRef.current)) {
            timer = setTimeout(tick, POLL_MS);
          }
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();

    const onVisible = () => {
      // Resume polling on re-show. Do NOT re-arm the rerun-watch here: re-arming reset the
      // deadline on every focus-return, so an alt-tabbing user could push it out indefinitely
      // and hang the button "Re-running…" forever (AC#3). The deadline stays fixed at arm time;
      // if it elapsed while hidden, the first tick on re-show runs updateRerunWatch and clears it
      // (nothing is rendered while hidden, so there is no visible hang in the meantime).
      if (document.visibilityState === 'visible' && !cancelled) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
      ctrl.abort(); // cross-series race guard: an in-flight old-SHA fetch is aborted
    };
    // refKey is the stable string proxy for prRef's primitives. refetchNonce drives off-timer
    // polls (arm + manual refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refKey captures prRef's identity
  }, [active, headSha, refKey, retryNonce, refetchNonce]);

  return { status, degraded, checks, retry, refetch, armRerunWatch, rerunPendingFor };
}
