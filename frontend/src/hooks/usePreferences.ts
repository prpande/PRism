import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { PreferencesResponse } from '../api/types';

export function usePreferences() {
  const [preferences, setPreferences] = useState<PreferencesResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      setPreferences(await apiClient.get<PreferencesResponse>('/api/preferences'));
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

  // POST body is the single-field allowlist contract (spec § 2.3). Keys are
  // the legacy bare ui.* names (`theme`, `accent`, `aiPreview`) OR the new
  // dotted inbox.sections.* names. Both reach the server's PatchAsync
  // allowlist. `string` here intentionally allows the dotted form without
  // requiring this hook to know the full key set up front — PR3's Settings
  // page consumers will tighten the type.
  const set = useCallback(async (key: string, value: unknown) => {
    const next = await apiClient.post<PreferencesResponse>('/api/preferences', { [key]: value });
    setPreferences(next);
    return next;
  }, []);

  return { preferences, error, refetch, set };
}
