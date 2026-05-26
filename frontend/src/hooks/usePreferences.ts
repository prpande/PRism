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

type InboxSectionKey = Exclude<PreferenceKey, 'theme' | 'accent' | 'aiPreview'>;

function readKey(prefs: PreferencesResponse, key: PreferenceKey): unknown {
  if (key === 'theme') return prefs.ui.theme;
  if (key === 'accent') return prefs.ui.accent;
  if (key === 'aiPreview') return prefs.ui.aiPreview;
  const id = key.slice('inbox.sections.'.length) as keyof PreferencesResponse['inbox']['sections'];
  return prefs.inbox.sections[id];
}

function writeKey(
  prefs: PreferencesResponse,
  key: PreferenceKey,
  value: unknown,
): PreferencesResponse {
  if (key === 'theme')
    return { ...prefs, ui: { ...prefs.ui, theme: value as PreferencesResponse['ui']['theme'] } };
  if (key === 'accent')
    return { ...prefs, ui: { ...prefs.ui, accent: value as PreferencesResponse['ui']['accent'] } };
  if (key === 'aiPreview') return { ...prefs, ui: { ...prefs.ui, aiPreview: value as boolean } };
  const id = (key as InboxSectionKey).slice(
    'inbox.sections.'.length,
  ) as keyof PreferencesResponse['inbox']['sections'];
  return {
    ...prefs,
    inbox: {
      ...prefs.inbox,
      sections: { ...prefs.inbox.sections, [id]: value as boolean },
    },
  };
}

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

  // Spec § 2.6 rollback: on POST failure, revert ONLY the failing key against
  // the latest state — not the whole-snapshot `prior` that captured pre-call
  // baseline. Whole-snapshot revert cascades: two near-simultaneous toggles
  // each snapshot the same `prior = P0`; if A succeeds and B fails, B's
  // rollback to P0 silently undoes A's successful local apply (the server is
  // still correct; the UI lies until a focus refetch). Key-scoped patching via
  // the functional setState form is race-safe because it composes against
  // current state, not the captured snapshot.
  const set = useCallback(
    async (key: PreferenceKey, value: unknown) => {
      const priorValue = preferences ? readKey(preferences, key) : undefined;
      try {
        const next = await apiClient.post<PreferencesResponse>('/api/preferences', {
          [key]: value,
        });
        setPreferences(next);
        return next;
      } catch (e) {
        if (preferences && priorValue !== undefined) {
          setPreferences((cur) => (cur ? writeKey(cur, key, priorValue) : cur));
        }
        show({ kind: 'error', message: `Couldn't save — ${key} reverted.` });
        throw e;
      }
    },
    [preferences, show],
  );

  return { preferences, error, refetch, set };
}
