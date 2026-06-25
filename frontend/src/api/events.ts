import type {
  DraftDiscardedEvent,
  DraftSavedEvent,
  DraftSubmittedEvent,
  InboxUpdatedEvent,
  MergeReadiness,
  Reviewer,
  RootCommentPostedEvent,
  SingleCommentPostedEvent,
  StateChangedEvent,
  SubmitDuplicateMarkerDetectedEvent,
  SubmitForeignPendingReviewEvent,
  SubmitOrphanCleanupFailedEvent,
  SubmitProgressEvent,
  SubmitStaleCommitOidEvent,
} from './types';

export type {
  InboxUpdatedEvent,
  StateChangedEvent,
  DraftSavedEvent,
  DraftDiscardedEvent,
  SubmitProgressEvent,
  SubmitForeignPendingReviewEvent,
  SubmitStaleCommitOidEvent,
  SubmitOrphanCleanupFailedEvent,
  SubmitDuplicateMarkerDetectedEvent,
  RootCommentPostedEvent,
  SingleCommentPostedEvent,
  DraftSubmittedEvent,
};

export type PrUpdatedEvent = {
  prRef: string;
  newHeadSha?: string;
  headShaChanged: boolean;
  baseShaChanged: boolean;
  newBaseSha?: string;
  commentCountDelta: number;
  isMerged: boolean;
  isClosed: boolean;
  // #598 Slice B — live merge-readiness. mergeReadinessChanged latches the value: only a change
  // TO a real (non-none) readiness sets it true (anti-flicker), so the FE updates the badge only
  // when the value is meaningful. Optional for back-compat with route-mock fixtures.
  mergeReadiness?: MergeReadiness;
  mergeReadinessChanged?: boolean;
  approvals?: number | null;
  changesRequested?: number | null;
  // #593 — live reviewer name-lists for the detail readiness popover (snapshot each tick).
  approvers?: Reviewer[] | null;
  changesRequestedBy?: Reviewer[] | null;
  awaitingReviewers?: Reviewer[] | null;
};

// Backend payload shape: SseEventProjection.IdentityChangedWire (Type: "identity-change").
// Frontend consumers only need to know the event fired — useAuth refetches /api/auth/state
// for the new login. No fields are read off the payload, but the wire still carries `type`.
export type IdentityChangedEvent = { type: string };

export type EventPayloadByType = {
  'inbox-updated': InboxUpdatedEvent;
  'pr-updated': PrUpdatedEvent;
  'state-changed': StateChangedEvent;
  'draft-saved': DraftSavedEvent;
  'draft-discarded': DraftDiscardedEvent;
  'submit-progress': SubmitProgressEvent;
  'submit-foreign-pending-review': SubmitForeignPendingReviewEvent;
  'submit-stale-commit-oid': SubmitStaleCommitOidEvent;
  'submit-orphan-cleanup-failed': SubmitOrphanCleanupFailedEvent;
  'submit-duplicate-marker-detected': SubmitDuplicateMarkerDetectedEvent;
  'identity-changed': IdentityChangedEvent;
  'root-comment-posted': RootCommentPostedEvent;
  'single-comment-posted': SingleCommentPostedEvent;
  'draft-submitted': DraftSubmittedEvent;
};

// SSE event names the EventSource must register listeners for. EventSource only dispatches
// `event:`-named frames whose name was passed to addEventListener — adding a type to
// EventPayloadByType is necessary but not sufficient; it must also appear here.
const EVENT_TYPES = [
  'inbox-updated',
  'pr-updated',
  'state-changed',
  'draft-saved',
  'draft-discarded',
  'submit-progress',
  'submit-foreign-pending-review',
  'submit-stale-commit-oid',
  'submit-orphan-cleanup-failed',
  'submit-duplicate-marker-detected',
  'identity-changed',
  'root-comment-posted',
  'single-comment-posted',
  'draft-submitted',
] as const satisfies readonly (keyof EventPayloadByType)[];

// Cross-provider bridges (spec § 3.2.1 reconnect-replay defense + § 3.1 in-flight
// guard refetch). useAuth runs at App-level OUTSIDE EventStreamProvider — it cannot
// call useEventSource(); it must subscribe to a window event dispatched from inside
// the SSE listener. useSubmitInFlight mirrors the pattern for symmetry.
const WINDOW_EVENT_BRIDGE: Partial<Record<keyof EventPayloadByType, string>> = {
  'identity-changed': 'prism-identity-changed',
  'state-changed': 'prism-state-changed',
};

export type StreamHealthHandle = {
  streamHealthy(): boolean;
  onHealthChange(cb: (healthy: boolean) => void): () => void; // returns unsubscribe
  forceReconnect(): void;
};

export type EventStreamHandle = {
  subscriberId(): Promise<string>;
  reconnectSignal(): AbortSignal;
  on<T extends keyof EventPayloadByType>(
    type: T,
    callback: (payload: EventPayloadByType[T]) => void,
  ): () => void;
  close(): void;
} & StreamHealthHandle;

const SILENCE_WATCHER_MS = 35_000;
const BASE_DELAY_MS = 1_000; // D2
const MAX_DELAY_MS = 30_000; // D2
const UNHEALTHY_AFTER_MS = 30_000;
const STABLE_AFTER_MS = 10_000;
const PING_TIMEOUT_MS = 5_000;

export function openEventStream(opts?: { random?: () => number }): EventStreamHandle {
  const random = opts?.random ?? Math.random;
  let es: EventSource;
  let idPromise: Promise<string>;
  let resolveId: (id: string) => void;
  let rejectId: (reason?: unknown) => void;
  let abortController: AbortController;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  let healthy = true; // optimistic
  const healthSubs = new Set<(h: boolean) => void>();
  let closed = false;
  // Tracks whether the first SSE connection has ever fully established (defined
  // as receiving the subscriber-assigned handshake). The cross-provider
  // prism-events-reconnected bridge fires only on subscriber-assigned events
  // that come AFTER the first one — i.e., signaling an actual reconnect that
  // the new stream has confirmed alive, not a still-pending HTTP open.
  let hasEverConnected = false;
  let attempt = 0;
  let reconnectPending = false;

  const listeners: { [K in keyof EventPayloadByType]?: Set<(p: EventPayloadByType[K]) => void> } =
    {};

  function newIdPromise() {
    idPromise = new Promise<string>((resolve, reject) => {
      resolveId = resolve;
      rejectId = reject;
    });
    // An orphaned handshake promise — rejected on teardown/reconnect before it
    // settled — must not surface as an unhandled rejection when nothing is
    // awaiting it. Consumers that DO await subscriberId() still observe the
    // rejection through their own await.
    idPromise.catch(() => {});
  }

  // Settle the in-flight handshake promise so awaiters of subscriberId() unblock
  // instead of hanging on a promise that newIdPromise()/teardown is about to
  // orphan (its resolveId is overwritten and can never fire). No-op if it already
  // resolved. The sole consumer (useActivePrUpdates) catches and retries.
  function rejectPendingHandshake() {
    rejectId(new Error('SSE stream torn down before handshake'));
  }

  function newAbortController() {
    abortController = new AbortController();
  }

  function notifyHealth(next: boolean) {
    if (closed) return;
    if (healthy === next) return;
    healthy = next;
    healthSubs.forEach((cb) => {
      try {
        cb(next);
      } catch {
        /* per-subscriber isolation */
      }
    });
  }

  function armWatchdog() {
    // watchdog ONLY (was resetWatchdog)
    if (watchdog) clearTimeout(watchdog);
    if (closed) return;
    watchdog = setTimeout(() => scheduleReconnect(), SILENCE_WATCHER_MS);
  }

  // The health countdown is armed once at init and re-armed only on a liveness signal
  // (onLiveness). It is deliberately NOT re-armed at connect()-tail: reconnect/backoff
  // churn must not restart the 30s countdown, or a fast-failing server would delay the
  // "connection lost" indicator past 30s.
  function armHealthTimer() {
    // (re)arm the 30s health countdown
    if (healthTimer) clearTimeout(healthTimer);
    if (closed) return;
    healthTimer = setTimeout(() => notifyHealth(false), UNHEALTHY_AFTER_MS);
  }

  function onLiveness() {
    // a confirmed liveness signal arrived
    notifyHealth(true);
    armHealthTimer();
    armWatchdog();
  }

  function computeDelay(n: number) {
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** n);
    return base * (0.75 + 0.5 * random()); // ±25% jitter
  }

  function armReconnectTimer(delay: number) {
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      reconnectPending = false;
      if (!closed) connect();
    }, delay);
  }

  // Replaces the old reconnect(). Re-entrancy guard (reconnectPending) collapses
  // rapid triggers (watchdog firing + onerror probe) into a single scheduled
  // reconnect. Backoff delay grows per consecutive attempt (D2/D8).
  function scheduleReconnect(options?: { immediate?: boolean }) {
    if (closed) return;
    if (reconnectPending) {
      // A reconnect is already scheduled. Normal triggers (watchdog firing +
      // onerror probe racing) collapse into the pending one. An immediate
      // trigger (forceReconnect / "Retry now") instead OVERRIDES the pending
      // backoff wait: cancel the armed timer and reschedule at 0. Without this
      // the "Retry now" button is a no-op for the entire backoff window — which
      // is exactly when the stream-health snackbar (PR2) puts it on screen. The
      // EventSource was already torn down + re-prepared by the original call, so
      // re-arming at 0 is sufficient; no second abort/close/id-rotation needed.
      if (!options?.immediate) return;
      if (backoffTimer) clearTimeout(backoffTimer);
      armReconnectTimer(0);
      return;
    }
    reconnectPending = true;
    abortController.abort();
    es.close();
    if (watchdog) clearTimeout(watchdog);
    if (dwellTimer) clearTimeout(dwellTimer);
    rejectPendingHandshake(); // unblock awaiters before the old promise is orphaned
    newIdPromise();
    newAbortController();
    armReconnectTimer(options?.immediate ? 0 : computeDelay(attempt++));
    // S6 PR4 (spec § 3.2.1) — reconnect-replay defense is signaled INSIDE the
    // subscriber-assigned handler in connect(), not here. Dispatching at this
    // point would fire before the new EventSource has actually opened (the
    // browser may still be doing the HTTP handshake), and scheduleReconnect can
    // be re-invoked rapidly via es.onerror probing — every retry would emit a
    // spurious "reconnected" signal even while the stream is still down.
    // See connect()'s subscriber-assigned handler for the actual dispatch.
  }

  function connect() {
    es = new EventSource('/api/events');
    const myEs = es;
    let probed = false;

    es.onerror = () => {
      if (probed || closed) return;
      // Captured-self guard: a watchdog-driven reconnect closes the previous EventSource
      // and creates a new one. Browsers can still deliver buffered onerror events on
      // the closed (now-superseded) instance afterwards. Ignore them — this closure
      // belongs to a stale EventSource and must not trigger another reconnect.
      if (myEs !== es) return;
      probed = true;
      // D3: bound the ping with an explicit abort timer. AbortSignal.timeout's
      // internal timer is not driven by vitest fake timers, so use a manual
      // setTimeout/AbortController pair instead. A ping that times out OR rejects
      // (network error) now schedules a reconnect rather than relying on
      // EventSource native retry — which a closed-socket onerror won't perform.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
      void fetch('/api/events/ping', { signal: ctrl.signal })
        .then((resp) => {
          clearTimeout(t);
          if (closed || myEs !== es) return;
          if (resp.status === 401) {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
            }
            closed = true; // tombstone: no further reconnects
            if (watchdog) clearTimeout(watchdog);
            if (backoffTimer) clearTimeout(backoffTimer);
            if (dwellTimer) clearTimeout(dwellTimer);
            if (healthTimer) clearTimeout(healthTimer);
            abortController.abort(); // notify reconnectSignal() awaiters the stream is dead
            rejectPendingHandshake(); // unblock subscriberId() awaiters on de-auth
            myEs.close();
            return;
          }
          scheduleReconnect();
        })
        .catch(() => {
          clearTimeout(t);
          if (closed || myEs !== es) return;
          scheduleReconnect();
        });
    };

    es.addEventListener('subscriber-assigned', (raw) => {
      try {
        const data = JSON.parse((raw as MessageEvent).data) as { subscriberId: string };
        resolveId(data.subscriberId);
      } catch {
        // Malformed handshake — schedule a reconnect so idPromise is not left
        // pending until the 35s watchdog. Return early to skip replay-dispatch
        // and resetWatchdog: a garbled frame is not a valid liveness signal.
        scheduleReconnect();
        return;
      }
      // Reconnect-replay defense (spec § 3.2.1): fire prism-events-reconnected
      // only on subscriber-assigned events that come AFTER the initial connect.
      // The initial connect's subscriber-assigned simply flips the flag. This
      // gates the bridge dispatch on "the new stream is confirmed alive" rather
      // than "connect() returned" — which the Copilot iter-4 review correctly
      // pointed out can fire while the HTTP handshake is still pending or even
      // when the stream is permanently down (es.onerror probing path).
      if (hasEverConnected) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('prism-events-reconnected'));
        }
      } else {
        hasEverConnected = true;
      }
      // D2: only a stream that SURVIVES the dwell resets the backoff attempt counter.
      // A drop before the dwell elapses → scheduleReconnect() clears this timer (D8),
      // so accept-then-drop keeps backoff growing.
      if (dwellTimer) clearTimeout(dwellTimer);
      dwellTimer = setTimeout(() => {
        if (!closed) attempt = 0;
      }, STABLE_AFTER_MS);
      onLiveness();
    });

    es.addEventListener('heartbeat', () => {
      onLiveness();
    });

    EVENT_TYPES.forEach((type) => {
      es.addEventListener(type, (raw) => {
        let parsed: EventPayloadByType[typeof type] | null = null;
        try {
          parsed = JSON.parse((raw as MessageEvent).data) as EventPayloadByType[typeof type];
        } catch {
          // Malformed payload — ignore. Skip BOTH the listeners.forEach loop AND
          // the cross-provider bridge dispatch: a garbled identity-changed frame
          // must not trigger an unintended useAuth refetch (a 401 there would
          // dispatch prism-auth-rejected on a stream whose malformed frame had
          // nothing to do with auth).
        }
        if (parsed !== null) {
          // Cross-provider bridge fires FIRST, before any in-tree listener runs.
          // Original order put the dispatch AFTER listeners.forEach, but a single
          // throwing listener callback would abort the try block and silently
          // suppress the bridge — useAuth + useSubmitInFlight would miss the
          // signal even though JSON.parse succeeded. Dispatching first guarantees
          // cross-provider consumers see every well-formed frame regardless of
          // in-tree subscriber behavior.
          const winEventName = WINDOW_EVENT_BRIDGE[type];
          if (winEventName !== undefined && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(winEventName));
          }
          const data = parsed;
          listeners[type]?.forEach((cb) => {
            try {
              (cb as (p: typeof data) => void)(data);
            } catch {
              // A throwing in-tree listener must not affect peer listeners or
              // the bridge dispatch already done above. Swallow per-subscriber.
            }
          });
        }
        // Liveness fires even when parsed === null: a malformed data frame still
        // proves the transport is reachable, so it resets the health timer +
        // watchdog. This is deliberately asymmetric with subscriber-assigned,
        // which skips onLiveness on a garbled frame and forces a reconnect —
        // there a malformed handshake means idPromise never resolves, so the
        // stream is functionally dead despite bytes arriving.
        onLiveness();
      });
    });

    armWatchdog();
  }

  newIdPromise();
  newAbortController();
  connect();
  armHealthTimer();

  return {
    subscriberId: () => idPromise,
    reconnectSignal: () => abortController.signal,
    on(type, callback) {
      const existing = listeners[type] as
        | Set<(p: EventPayloadByType[typeof type]) => void>
        | undefined;
      const set = existing ?? new Set<(p: EventPayloadByType[typeof type]) => void>();
      (listeners as Record<string, Set<(p: unknown) => void>>)[type] = set as Set<
        (p: unknown) => void
      >;
      set.add(callback);
      return () => {
        set.delete(callback);
      };
    },
    streamHealthy: () => healthy,
    onHealthChange(cb) {
      healthSubs.add(cb);
      return () => {
        healthSubs.delete(cb);
      };
    },
    forceReconnect() {
      scheduleReconnect({ immediate: true });
    },
    close() {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      if (backoffTimer) clearTimeout(backoffTimer);
      if (dwellTimer) clearTimeout(dwellTimer);
      if (healthTimer) clearTimeout(healthTimer);
      abortController.abort();
      rejectPendingHandshake(); // unblock any subscriberId() awaiter at unmount
      es.close();
    },
  };
}
