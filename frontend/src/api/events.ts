export type InboxUpdatedEvent = {
  changedSectionIds: string[];
  newOrUpdatedPrCount: number;
};

export type PrUpdatedEvent = {
  prRef: string;
  newHeadSha?: string;
  headShaChanged: boolean;
  commentCountDelta: number;
};

export type EventPayloadByType = {
  'inbox-updated': InboxUpdatedEvent;
  'pr-updated': PrUpdatedEvent;
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

export function openEventStream(): EventStreamHandle {
  let es: EventSource;
  let idPromise: Promise<string>;
  let resolveId: (id: string) => void;
  let abortController: AbortController;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

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
    watchdog = setTimeout(reconnect, SILENCE_WATCHER_MS);
  }

  function reconnect() {
    if (closed) return;
    abortController.abort();
    es.close();
    newIdPromise();
    newAbortController();
    connect();
  }

  function connect() {
    es = new EventSource('/api/events');
    let probed = false;

    es.onerror = () => {
      if (probed || closed) return;
      probed = true;
      void fetch('/api/events/ping')
        .then((resp) => {
          if (closed) return;
          if (resp.status === 401) {
            window.location.reload();
            return;
          }
          reconnect();
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
      resetWatchdog();
    });

    es.addEventListener('heartbeat', () => {
      resetWatchdog();
    });

    (['inbox-updated', 'pr-updated'] as const).forEach((type) => {
      es.addEventListener(type, (raw) => {
        try {
          const data = JSON.parse((raw as MessageEvent).data) as EventPayloadByType[typeof type];
          listeners[type]?.forEach((cb) => (cb as (p: typeof data) => void)(data));
        } catch {
          // Malformed payload — ignore.
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
      const set = (listeners[type] ??= new Set()) as Set<typeof callback>;
      set.add(callback);
      return () => {
        set.delete(callback);
      };
    },
    close() {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      abortController.abort();
      es.close();
    },
  };
}
