import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
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
  | 'density'
  | 'contentScale'
  | 'inbox.defaultSort'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'recently-closed'}`;

type InboxSectionKey = Exclude<
  PreferenceKey,
  'theme' | 'accent' | 'aiPreview' | 'density' | 'contentScale' | 'inbox.defaultSort'
>;

export function readKey(prefs: PreferencesResponse, key: PreferenceKey): unknown {
  if (key === 'theme') return prefs.ui.theme;
  if (key === 'accent') return prefs.ui.accent;
  if (key === 'aiPreview') return prefs.ui.aiPreview;
  if (key === 'density') return prefs.ui.density;
  if (key === 'contentScale') return prefs.ui.contentScale;
  if (key === 'inbox.defaultSort') return prefs.inbox.defaultSort;
  const id = key.slice('inbox.sections.'.length) as keyof PreferencesResponse['inbox']['sections'];
  return prefs.inbox.sections[id];
}

export function writeKey(
  prefs: PreferencesResponse,
  key: PreferenceKey,
  value: unknown,
): PreferencesResponse {
  if (key === 'theme')
    return { ...prefs, ui: { ...prefs.ui, theme: value as PreferencesResponse['ui']['theme'] } };
  if (key === 'accent')
    return { ...prefs, ui: { ...prefs.ui, accent: value as PreferencesResponse['ui']['accent'] } };
  if (key === 'aiPreview') return { ...prefs, ui: { ...prefs.ui, aiPreview: value as boolean } };
  if (key === 'density')
    return {
      ...prefs,
      ui: { ...prefs.ui, density: value as PreferencesResponse['ui']['density'] },
    };
  if (key === 'contentScale')
    return {
      ...prefs,
      ui: { ...prefs.ui, contentScale: value as PreferencesResponse['ui']['contentScale'] },
    };
  if (key === 'inbox.defaultSort')
    return {
      ...prefs,
      inbox: {
        ...prefs.inbox,
        defaultSort: value as PreferencesResponse['inbox']['defaultSort'],
      },
    };
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

export interface PreferencesContextValue {
  preferences: PreferencesResponse | null;
  error: Error | null;
  refetch(): Promise<void>;
  // Resolves with the updated snapshot, or throws on POST failure (after the
  // optimistic rollback + error toast) — never resolves `undefined`.
  set(key: PreferenceKey, value: unknown): Promise<PreferencesResponse>;
}

// Exported as a test seam so a unit test can supply a stub context value without
// the full PreferencesProvider. Application code consumes via usePreferences(),
// not this object directly. Mirrors OpenTabsContext.
export const PreferencesContext = createContext<PreferencesContextValue | null>(null);

// The actual preferences store: state + the GET /api/preferences fetch + the
// window-`focus` refetch listener + the optimistic `set`. Used in two ways:
//  - PreferencesProvider calls it once (enabled) and shares the value, so the
//    whole app gets ONE fetch on mount + ONE per focus (the #143 dedup).
//  - usePreferences() calls it as an INERT instance (enabled=false) while a
//    provider supplies the value, and as a LIVE fallback when there's no
//    provider (isolated tests, or any out-of-provider render). The `enabled`
//    gate is what keeps the inert instance from firing a duplicate request.
// `enabled` is derived from provider-presence, which is stable for a given
// consumer across its lifetime, so this never reorders hooks.
function usePreferencesStore(enabled: boolean): PreferencesContextValue {
  const [preferences, setPreferences] = useState<PreferencesResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const { show } = useToast();

  const refetch = useCallback(async () => {
    try {
      setPreferences(await apiClient.get<PreferencesResponse>('/api/preferences'));
      // Clear any error from a prior failed attempt so `error` reflects the
      // latest fetch (it is now shared across all consumers).
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refetch();
    const handler = () => {
      void refetch();
    };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [enabled, refetch]);

  // Spec § 2.6 rollback: on POST failure, revert ONLY the failing key against
  // the latest state — not the whole-snapshot `prior` that captured pre-call
  // baseline. Whole-snapshot revert cascades: two near-simultaneous toggles
  // each snapshot the same `prior = P0`; if A succeeds and B fails, B's
  // rollback to P0 silently undoes A's successful local apply (the server is
  // still correct; the UI lies until a focus refetch). Key-scoped patching via
  // the functional setState form is race-safe because it composes against
  // current state, not the captured snapshot. Under the shared provider this is
  // strictly safer than before — two consumers toggling now hit one
  // setPreferences queue instead of two independent states that could diverge.
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
        // Generic copy: the internal dotted-path key (`inbox.sections.awaiting-author`,
        // etc.) is a wire-format detail with no value to the end user. If a
        // consumer wants key-specific wording it can catch the rejection and
        // show its own toast.
        show({
          kind: 'error',
          message: "Couldn't save preference — your change was reverted.",
        });
        throw e;
      }
    },
    [preferences, show],
  );

  // Memoized so an unrelated provider re-render doesn't churn every consumer
  // (mirrors OpenTabsContext.tsx). `set`'s identity legitimately tracks
  // `preferences` (its useCallback dep — inherent to rollback-against-current-
  // state), so the value changes on each preference update; that is the intended
  // "value changed" signal to consumers, not churn.
  return useMemo<PreferencesContextValue>(
    () => ({ preferences, error, refetch, set }),
    [preferences, error, refetch, set],
  );
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const value = usePreferencesStore(true);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

// Lenient like useEventSource(): in the app a PreferencesProvider is always
// present (mounted at the root, above the route table, under the top-level
// ErrorBoundary), so every consumer shares its single fetch. Outside a provider
// — an isolated unit test, or any future out-of-provider render — usePreferences
// falls back to a LIVE local store (the pre-#143 per-consumer behavior) instead
// of throwing. The local store is INERT whenever the context supplies the value,
// so it never issues a duplicate request on the shared path.
export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  const fallback = usePreferencesStore(ctx == null);
  return ctx ?? fallback;
}
