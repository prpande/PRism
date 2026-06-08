import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiClient } from '../api/client';
import type { AuthState, ConnectResponse } from '../api/types';

export interface AuthContextValue {
  authState: AuthState | null;
  error: Error | null;
  // Resolves to the freshly-fetched AuthState, or null if the fetch failed.
  // Callers that navigate on the result (SetupPage) MUST check the return value
  // rather than assuming success — refetch swallows the error into `error` state
  // so it never rejects, which would otherwise let a failed /api/auth/state
  // fetch fall through to a navigate into a stale routing-gate bounce.
  refetch: () => Promise<AuthState | null>;
  connect: (pat: string) => Promise<ConnectResponse>;
}

// A SINGLE shared auth instance, not per-call-site local state. Before this was
// a context, App.tsx and SetupPage.tsx each called useAuth() and got their own
// independent `authState`. SetupPage committing a token (and refetching) could
// not update App's copy — and App's copy is the one that gates routing
// (`isAuthed = hasToken && !authInvalidated`). The result was a first-run
// bounce: paste token → navigate('/') → App's stale hasToken=false → redirect
// back to /setup, forcing a second "Get Started" click. Sharing one instance
// lets SetupPage `await refetch()` so the gate sees hasToken=true BEFORE it
// navigates. Regression net: app.test.tsx "lands on the Inbox after first-run
// token submission".
const AuthContext = createContext<AuthContextValue | null>(null);

function useAuthState(): AuthContextValue {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async (): Promise<AuthState | null> => {
    try {
      const next = await apiClient.get<AuthState>('/api/auth/state');
      setAuthState(next);
      return next;
    } catch (e) {
      setError(e as Error);
      return null;
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
    // event (Replace token → identity-change rule). AuthProvider is mounted at
    // the top of App (App.tsx wraps AppShell unconditionally — above the auth
    // gate AND above EventStreamProvider), so useAuthState can't subscribe via
    // useEventSource(); the window event is the only reachable signal.
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthState();
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
