import type { AuthState, InboxUpdatedEvent } from './types';

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
  // EventSource auto-reconnects and exposes neither status nor body to JS, so a
  // 401 from the server (e.g. token revoked while a tab is open) silently loops
  // forever. On the first error we probe /api/auth/state once and, if the token
  // is gone, fire the same auth-rejected event the REST client uses so the app
  // demotes to /setup consistently.
  let probed = false;
  es.onerror = () => {
    if (probed) return;
    probed = true;
    void fetch('/api/auth/state')
      .then((resp) => (resp.ok ? (resp.json() as Promise<AuthState>) : null))
      .then((state) => {
        if (state && state.hasToken === false) {
          window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
        }
      })
      .catch(() => {
        // Network error probing auth state — leave EventSource to keep retrying.
      });
  };
  return () => es.close();
}
