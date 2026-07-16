// frontend/src/hooks/useCheckRuns.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCheckRuns } from '../api/checks';
import { ApiError } from '../api/client';
import type { CheckRun, DegradedReason, PrReference } from '../api/types';

const POLL_MS = 15_000;
const LATE_REGISTRATION_MS = 120_000; // ~2 min re-poll window on a still-empty list
// #743 — dwell before an eager prefetch issues its request. Rapid tab-switch drive-bys cancel
// the pending timer at zero API cost, and the single attempt per head is only burned once a
// request actually starts (also keeps dev StrictMode's mount→unmount→mount from consuming it).
const PREFETCH_DWELL_MS = 300;
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
  // #743 — last known list, surviving series (headSha) transitions so the tab-strip glyph
  // holds the prior head's verdict instead of blank-flickering on every push; replaced as
  // soon as the new head's first result lands. Optional for the same reason as the rerun
  // members: ~10 test files build this result inline for tabs that never touch the glyph.
  glyphChecks?: CheckRun[];
}

const isNonTerminal = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';

export function useCheckRuns(
  prRef: PrReference,
  headSha: string | undefined,
  active: boolean,
  prefetch = false,
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
  // #743 — glyph continuity: mirrors `checks` on every successful write but is NOT cleared by
  // the series transition, so the tab-strip glyph holds the prior head's verdict until the new
  // head's first result lands.
  const glyphChecksRef = useRef<CheckRun[] | undefined>(undefined);
  // #743 — single-flight prefetch gate, SHA-keyed. Marked when a request is ISSUED on either
  // path (prefetch dwell elapsed, or a poll tick fired) and never unmarked: one prefetch-eligible
  // request per head, full stop. A new head invalidates it naturally; no series-block reset.
  const prefetchedShaRef = useRef<string | undefined>(undefined);
  // #743 — the head whose series already had its first Checks-tab activation. A per-series
  // once-latch, NOT an active-edge detector: re-activations, retry/refetch nonce re-runs, and
  // transient gate closures (hidden, headSha momentarily null) never re-fire the
  // first-activation actions, so re-visit behavior matches pre-prefetch semantics exactly.
  const seriesActivatedShaRef = useRef<string | undefined>(undefined);

  const refKey = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  // Series identity transition, shared by the poll effect and the prefetch effect (#743) so a
  // prefetched series is recognized (not cleared) when the tab activates. New SHA: clear the
  // prior head's verdict, reset the degraded banner, (re)open the late-registration window,
  // and drop any in-flight rerun-watch (its checkRunId belongs to the old series). A same-SHA
  // call is a no-op (stale-while-revalidate preserves the last list). `glyphChecksRef`
  // deliberately survives the transition (glyph continuity).
  const beginSeriesIfNew = (sha: string) => {
    if (seriesShaRef.current === sha) return;
    seriesShaRef.current = sha;
    windowOpenedAtRef.current = Date.now();
    setChecks([]);
    checksRef.current = [];
    hadSuccessRef.current = false;
    setDegraded('none');
    setStatus('loading');
    watchedIdRef.current = null;
    watchUntilRef.current = 0;
    setRerunPendingFor(null);
  };

  const classifyDegraded = (err: unknown): DegradedReason =>
    // 401/403 from PRism's own endpoint = auth (mirrors the reader's DegradedFor);
    // anything else is transient.
    err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'auth' : 'transient';

  // Success-commit chokepoint shared by the poll tick and the prefetch — the only place the
  // list is written, so `checksRef` and the glyph mirror can never drift from `checks`.
  const commitChecks = (list: CheckRun[]) => {
    setChecks(list);
    checksRef.current = list;
    glyphChecksRef.current = list;
    setStatus(list.length === 0 ? 'empty' : 'ok');
  };

  // Failure-commit chokepoint, shared likewise. `surfaceColdError` separates the two paths:
  // the poll tick surfaces a cold failure as the error card (the tab is mounted and the user
  // is looking at it), but a failed PREFETCH must not — the Checks tab is unmounted, nothing
  // legitimately consumes 'error' pre-visit, and the first activation would paint the error
  // card for a frame before the latch's post-mount loading reset runs (Copilot review,
  // PR #768). A failed prefetch leaves the series on 'loading': the first visit renders the
  // skeleton, the activation tick retries, and only THAT failure surfaces the error card.
  // The warm arm restores the cached list's status (stale-while-revalidate).
  const commitFetchError = (err: unknown, surfaceColdError: boolean) => {
    setDegraded(classifyDegraded(err));
    if (!hadSuccessRef.current) {
      if (surfaceColdError) setStatus('error');
    } else {
      setStatus(checksRef.current.length === 0 ? 'empty' : 'ok');
    }
  };

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

    beginSeriesIfNew(headSha!);

    // #743 — a prefetch may have established this series minutes before the user actually
    // looks at the tab. Once per series, on its FIRST activation only:
    //  - a still-empty list gets its late-registration grace re-anchored to activation time
    //    (a late visitor keeps the full ~2-min re-poll window instead of inheriting an
    //    expired one) — re-visits must NOT re-arm, or tab-flipping would grant unbounded
    //    polling windows on a checks-less PR;
    //  - a series whose prefetch failed cold resets to 'loading' so the first visit renders
    //    the normal skeleton→result sequence, never an error-first mount — re-visits keep the
    //    error card over the silent retry, as today.
    // For a series first established by this effect itself (manual visit, deep link), both
    // actions are same-instant no-ops after beginSeriesIfNew.
    if (seriesActivatedShaRef.current !== headSha) {
      seriesActivatedShaRef.current = headSha;
      if (checksRef.current.length === 0) {
        windowOpenedAtRef.current = Date.now();
      }
      if (!hadSuccessRef.current) {
        setStatus('loading');
      }
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
      // #743 — the gate closes on ISSUE, either path. Idempotent: re-assigning the same value
      // on every 15s tick is deliberate; only the first write matters.
      prefetchedShaRef.current = headSha;
      try {
        const res = await getCheckRuns(prRef, headSha!, ctrl.signal);
        if (cancelled || res.headSha !== headSha) return; // cross-series backstop
        hadSuccessRef.current = true;
        setDegraded(res.degraded);
        // updateRerunWatch first — it may clear the watch (a transition or the wall-clock
        // expiry), which gates the hold-cached decision immediately below.
        updateRerunWatch(res.checks);
        // Stale-while-revalidate across a re-run: right after a rerequest/rerun GitHub briefly
        // reports ZERO check-runs for the commit while it resets the suite. While the watch is
        // still live, keep the cached list on screen instead of flashing "No checks for this
        // commit" — the re-run's checks replace it on a later tick. Once the watch ends, an
        // empty result is accepted normally (it then genuinely means no checks).
        const holdCached =
          res.checks.length === 0 && watchedIdRef.current != null && checksRef.current.length > 0;
        if (!holdCached) {
          commitChecks(res.checks);
        }
        if (shouldKeepPolling(res.checks)) {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        // Cold arm surfaces the error screen (the tab is mounted); warm arm keeps the
        // last-known list on screen (stale-while-revalidate) so a transient blip self-heals.
        commitFetchError(err, true);
        // Expire the rerun-watch on a FAILING tick too. Without this, a poll that throws while
        // crossing the watch-window boundary never runs the window-expiry clear; the watch then
        // stays armed, shouldKeepPolling can return false, the loop stops, and rerunPendingFor is
        // stuck non-null → the button hangs "Re-running…" forever (AC#3). updateRerunWatch over
        // the stale list won't clear early but DOES clear once the window has elapsed.
        updateRerunWatch(checksRef.current);
        if (!hadSuccessRef.current) {
          // The loop stops here without the window necessarily having elapsed; drop any armed
          // watch so rerunPendingFor can't be left stuck (defensive — unreachable today because
          // the Re-run button only renders when status==='ok', which forces hadSuccessRef true
          // before a watch can be armed; this guards a future refactor).
          watchedIdRef.current = null;
          watchUntilRef.current = 0;
          setRerunPendingFor(null);
        } else if (shouldKeepPolling(checksRef.current)) {
          timer = setTimeout(tick, POLL_MS);
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

  // #743 — eager one-shot prefetch: fire the initial fetch while the PR-detail view is open on
  // any sub-tab, so the first Checks visit (and the tab-strip glyph) has data. Strictly
  // best-effort and strictly bounded: a dwell timer precedes the request (drive-by view flips
  // cost nothing), the SHA-keyed gate is marked at request START and never unmarked (one issued
  // request per head, no retry on abort or failure — recovery is tab activation, which behaves
  // like today's cold open via the activation-edge reset above), and there is deliberately no
  // poll loop here. Hidden documents defer the attempt to the first visibility return.
  useEffect(() => {
    if (!prefetch || active || headSha == null) return;
    if (prefetchedShaRef.current === headSha) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let visListener: (() => void) | null = null;
    const ctrl = new AbortController();

    const fire = async () => {
      beginSeriesIfNew(headSha);
      prefetchedShaRef.current = headSha;
      try {
        const res = await getCheckRuns(prRef, headSha, ctrl.signal);
        if (cancelled || res.headSha !== headSha) return; // cross-series backstop
        hadSuccessRef.current = true;
        setDegraded(res.degraded);
        commitChecks(res.checks);
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        // surfaceColdError=false: a failed prefetch stays on 'loading' — see commitFetchError.
        commitFetchError(err, false);
      }
    };

    const armDwell = () => {
      timer = setTimeout(() => void fire(), PREFETCH_DWELL_MS);
    };

    if (document.visibilityState === 'visible') {
      armDwell();
    } else {
      // Opened hidden (app launched minimized / backgrounded during load): one-shot,
      // self-removing listener starts the dwell on the first return to visibility.
      visListener = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', visListener!);
        visListener = null;
        armDwell(); // cleanup removes the listener synchronously, so no cancelled check needed
      };
      document.addEventListener('visibilitychange', visListener);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (visListener) document.removeEventListener('visibilitychange', visListener);
      ctrl.abort();
    };
    // refKey is the stable string proxy for prRef's primitives; beginSeriesIfNew is
    // recreated per render but only closes over stable refs/setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refKey captures prRef's identity
  }, [prefetch, active, headSha, refKey]);

  return {
    status,
    degraded,
    checks,
    retry,
    refetch,
    armRerunWatch,
    rerunPendingFor,
    glyphChecks: glyphChecksRef.current,
  };
}
