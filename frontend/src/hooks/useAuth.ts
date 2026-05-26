import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { AuthState, ConnectResponse } from '../api/types';

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      setAuthState(await apiClient.get<AuthState>('/api/auth/state'));
    } catch (e) {
      setError(e as Error);
    }
  }, []);

  useEffect(() => {
    void refetch();
    const handler = () => {
      void refetch();
    };
    window.addEventListener('focus', handler);
    // S6 PR4 (spec § 3.2.1) — `prism-identity-changed` is dispatched by the SSE
    // bridge in api/events.ts whenever the backend publishes an IdentityChanged
    // event (Replace token → identity-change rule). useAuth lives ABOVE
    // EventStreamProvider in the tree (App.tsx mounts the provider inside the
    // auth-gated subtree), so it can't subscribe via useEventSource(); the
    // window event is the only reachable signal.
    window.addEventListener('prism-identity-changed', handler);
    // Reconnect-replay defense (spec § 3.2.1): the SSE channel doesn't replay
    // events fired during a disconnect, so refetch auth state on every reconnect
    // to catch identity changes that landed while we were offline.
    window.addEventListener('prism-events-reconnected', handler);
    return () => {
      window.removeEventListener('focus', handler);
      window.removeEventListener('prism-identity-changed', handler);
      window.removeEventListener('prism-events-reconnected', handler);
    };
  }, [refetch]);

  const connect = useCallback(async (pat: string) => {
    return apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
  }, []);

  return { authState, error, refetch, connect };
}
