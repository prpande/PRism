import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import { useToast } from '../components/Toast';
import type { PreferencesResponse } from '../api/types';

// Settings page (spec § 2.6) tightens the dotted-path key set from the bare
// `string` PR1 ship to the union below. Bare `theme`/`accent`/`aiPreview` keep
// the back-compat path used by HeaderControls; `inbox.sections.*` are the new
// Settings page keys.
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'aiPreview'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'ci-failing'}`;

export function usePreferences() {
  const [preferences, setPreferences] = useState<PreferencesResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const { show } = useToast();

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

  // Spec § 2.6 rollback: capture the snapshot before the POST so a 4xx/5xx/network
  // failure restores the prior value AND surfaces a single error toast. The hook
  // intentionally does NOT pre-apply the change locally — the server's response is
  // the source of truth, and a pre-apply would briefly show a value that may never
  // be persisted. The visible UX is "control briefly looks unchanged, then flips
  // (success) or stays + toast (failure)" rather than "control flips, snaps back".
  const set = useCallback(
    async (key: PreferenceKey, value: unknown) => {
      const prior = preferences;
      try {
        const next = await apiClient.post<PreferencesResponse>('/api/preferences', {
          [key]: value,
        });
        setPreferences(next);
        return next;
      } catch (e) {
        if (prior) setPreferences(prior);
        show({ kind: 'error', message: `Couldn't save — ${key} reverted.` });
        throw e;
      }
    },
    [preferences, show],
  );

  return { preferences, error, refetch, set };
}
