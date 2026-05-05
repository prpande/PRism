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
  }, [refetch]);

  const connect = useCallback(async (pat: string) => {
    return apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
  }, []);

  return { authState, error, refetch, connect };
}
