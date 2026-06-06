import type {
  DraftDiscardedEvent,
  DraftSavedEvent,
  InboxUpdatedEvent,
  RootCommentPostedEvent,
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
};

export type PrUpdatedEvent = {
  prRef: string;
  newHeadSha?: string;
  headShaChanged: boolean;
  commentCountDelta: number;
  isMerged: boolean;
  isClosed: boolean;
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
] as const satisfies readonly (keyof EventPayloadByType)[];

// Cross-provider bridges (spec § 3.2.1 reconnect-replay defense + § 3.1 in-flight
// guard refetch). useAuth runs at App-level OUTSIDE EventStreamProvider — it cannot
// call useEventSource(); it must subscribe to a window event dispatched from inside
// the SSE listener. useSubmitInFlight mirrors the pattern for symmetry.
const WINDOW_EVENT_BRIDGE: Partial<Record<keyof EventPayloadByType, string>> = {
  'identity-changed': 'prism-identity-changed',
  'state-changed': 'prism-state-changed',
};

export type EventStreamHandle = {
  subscriberId(): Promise<string>;
  reconnectSignal(): AbortSignal;
  on<T extends keyof EventPayloadByType>(
    type: T,
    callback: (payload: EventPayloadByType[T]) => void,
  ): () => void;
  close(): void;
};

const SILENCE_WATCHER_MS = 35_000;
const BASE_DELAY_MS = 1_000; // D2
const MAX_DELAY_MS = 30_000; // D2
// Pre-staged constants consumed by later tasks in this PR. The eslint-disable
// markers come off as each one gains its first reference.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used Task 6 (D5)
const UNHEALTHY_AFTER_MS = 30_000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used Task 5 (D2 dwell)
const STABLE_AFTER_MS = 10_000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used Task 2 (D3)
const PING_TIMEOUT_MS = 5_000;

export function openEventStream(opts?: { random?: () => number }): EventStreamHandle {
  const random = opts?.random ?? Math.random;
  let es: EventSource;
  let idPromise: Promise<string>;
  let resolveId: (id: string) => void;
  let abortController: AbortController;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
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
    idPromise = new Promise<string>((resolve) => {
      resolveId = resolve;
    });
  }

  function newAbortController() {
    abortController = new AbortController();
  }

  function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    if (closed) return;
    watchdog = setTimeout(() => scheduleReconnect(), SILENCE_WATCHER_MS);
  }

  function computeDelay(n: number) {
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** n);
    return base * (0.75 + 0.5 * random()); // ±25% jitter
  }

  // Replaces the old reconnect(). Re-entrancy guard (reconnectPending) collapses
  // rapid triggers (watchdog firing + onerror probe) into a single scheduled
  // reconnect. Backoff delay grows per consecutive attempt (D2/D8).
  // immediate=true is a dead branch until Task 7.
  function scheduleReconnect(options?: { immediate?: boolean }) {
    if (closed || reconnectPending) return;
    reconnectPending = true;
    abortController.abort();
    es.close();
    if (watchdog) clearTimeout(watchdog);
    if (dwellTimer) clearTimeout(dwellTimer);
    newIdPromise();
    newAbortController();
    const delay = options?.immediate ? 0 : computeDelay(attempt++);
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      reconnectPending = false;
      if (!closed) connect();
    }, delay);
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
      void fetch('/api/events/ping')
        .then((resp) => {
          if (closed || myEs !== es) return;
          if (resp.status === 401) {
            window.location.reload();
            return;
          }
          scheduleReconnect();
        })
        .catch(() => {
          // Network error probing — leave EventSource native retry to handle.
        });
    };

    es.addEventListener('subscriber-assigned', (raw) => {
      try {
        const data = JSON.parse((raw as MessageEvent).data) as { subscriberId: string };
        resolveId(data.subscriberId);
      } catch {
        // Malformed handshake — leave promise pending; next reconnect retries.
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
      resetWatchdog();
    });

    es.addEventListener('heartbeat', () => {
      resetWatchdog();
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
        resetWatchdog();
      });
    });

    resetWatchdog();
  }

  newIdPromise();
  newAbortController();
  connect();

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
    close() {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      if (backoffTimer) clearTimeout(backoffTimer);
      if (dwellTimer) clearTimeout(dwellTimer);
      abortController.abort();
      es.close();
    },
  };
}
