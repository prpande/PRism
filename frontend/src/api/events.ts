import type { InboxUpdatedEvent } from './types';

export type EventListeners = {
  onInboxUpdated?: (e: InboxUpdatedEvent) => void;
};

export function openEventStream(listeners: EventListeners): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('inbox-updated', (raw) => {
    try {
      const data = JSON.parse((raw as MessageEvent).data) as InboxUpdatedEvent;
      listeners.onInboxUpdated?.(data);
    } catch {
      // Malformed SSE event payload — ignore (server bug, not user-facing).
    }
  });
  return () => es.close();
}
