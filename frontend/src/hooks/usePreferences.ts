import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { UiPreferences } from '../api/types';

export function usePreferences() {
  const [preferences, setPreferences] = useState<UiPreferences | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      setPreferences(await apiClient.get<UiPreferences>('/api/preferences'));
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
    return () => window.removeEventListener('focus', handler);
  }, [refetch]);

  const set = useCallback(async (key: keyof UiPreferences, value: unknown) => {
    const next = await apiClient.post<UiPreferences>('/api/preferences', { [key]: value });
    setPreferences(next);
    return next;
  }, []);

  return { preferences, error, refetch, set };
}
