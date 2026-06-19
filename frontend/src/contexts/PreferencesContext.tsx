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
import type { PreferencesResponse, AiMode } from '../api/types';

// Settings page (spec § 2.6) tightens the dotted-path key set from the bare
// `string` PR1 ship to the union below. Bare `theme`/`accent` keep the
// back-compat path used by HeaderControls; `inbox.sections.*` are the new
// Settings page keys.
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'ui.ai.mode'
  | 'ui.ai.providerTimeoutSeconds'
  | 'ui.ai.hunkAnnotationCap'
  | 'ui.ai.summaryMaxChars'
  | `ui.ai.features.${'summary' | 'fileFocus' | 'hunkAnnotations' | 'inboxEnrichment'}`
  | 'density'
  | 'contentScale'
  | 'inbox.defaultSort'
  | 'inbox.sectionOrder'
  | 'inbox.showActivityRail'
  | 'inbox.groupByRepo'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'recently-closed'}`;

type InboxSectionKey = Exclude<
  PreferenceKey,
  | 'theme'
  | 'accent'
  | 'ui.ai.mode'
  | 'ui.ai.providerTimeoutSeconds'
  | 'ui.ai.hunkAnnotationCap'
  | 'ui.ai.summaryMaxChars'
  | `ui.ai.features.${'summary' | 'fileFocus' | 'hunkAnnotations' | 'inboxEnrichment'}`
  | 'density'
  | 'contentScale'
  | 'inbox.defaultSort'
  | 'inbox.sectionOrder'
  | 'inbox.showActivityRail'
  | 'inbox.groupByRepo'
>;

export function readKey(prefs: PreferencesResponse, key: PreferenceKey): unknown {
  if (key === 'theme') return prefs.ui.theme;
  if (key === 'accent') return prefs.ui.accent;
  if (key === 'ui.ai.mode') return prefs.ui.aiMode;
  if (key === 'ui.ai.providerTimeoutSeconds') return prefs.ui.providerTimeoutSeconds;
  if (key === 'ui.ai.hunkAnnotationCap') return prefs.ui.hunkAnnotationCap;
  if (key === 'ui.ai.summaryMaxChars') return prefs.ui.summaryMaxChars;
  if (key === 'density') return prefs.ui.density;
  if (key === 'contentScale') return prefs.ui.contentScale;
  if (key === 'inbox.defaultSort') return prefs.inbox.defaultSort;
  if (key === 'inbox.sectionOrder') return prefs.inbox.sectionOrder;
  if (key === 'inbox.showActivityRail') return prefs.inbox.showActivityRail;
  if (key === 'inbox.groupByRepo') return prefs.inbox.groupByRepo;
  if (key.startsWith('ui.ai.features.'))
    return prefs.ui.features?.[
      key.slice('ui.ai.features.'.length) as keyof PreferencesResponse['ui']['features']
    ];
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
  if (key === 'ui.ai.mode') return { ...prefs, ui: { ...prefs.ui, aiMode: value as AiMode } };
  if (key === 'ui.ai.providerTimeoutSeconds')
    return { ...prefs, ui: { ...prefs.ui, providerTimeoutSeconds: value as number } };
  if (key === 'ui.ai.hunkAnnotationCap')
    return { ...prefs, ui: { ...prefs.ui, hunkAnnotationCap: value as number } };
  if (key === 'ui.ai.summaryMaxChars')
    return { ...prefs, ui: { ...prefs.ui, summaryMaxChars: value as number } };
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
  if (key === 'inbox.sectionOrder')
    return {
      ...prefs,
      inbox: {
        ...prefs.inbox,
        sectionOrder: value as PreferencesResponse['inbox']['sectionOrder'],
      },
    };
  if (key === 'inbox.showActivityRail')
    return { ...prefs, inbox: { ...prefs.inbox, showActivityRail: value as boolean } };
  if (key === 'inbox.groupByRepo')
    return { ...prefs, inbox: { ...prefs.inbox, groupByRepo: value as boolean } };
  if (key.startsWith('ui.ai.features.')) {
    const seam = key.slice('ui.ai.features.'.length) as keyof PreferencesResponse['ui']['features'];
    // writeKey is a test-only helper (no production callers). When prefs.ui.features
    // is undefined this returns a features object holding only the written seam;
    // acceptable because AiFeatures has no cross-field invariants and tests write/read
    // the same seam — real GET responses always populate all nine keys.
    return {
      ...prefs,
      ui: {
        ...prefs.ui,
        features: {
          ...prefs.ui.features,
          [seam]: value as boolean,
        } as PreferencesResponse['ui']['features'],
      },
    };
  }
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
  // Resolves with the updated snapshot, or throws on POST failure (with an error
  // toast). Apply-on-success (NOT optimistic): local state is written only after
  // the POST resolves, so a failed save leaves the prior value untouched — there
  // is nothing to roll back, and this never resolves `undefined`.
  set(key: PreferenceKey, value: unknown): Promise<PreferencesResponse>;
}

// Exported as a test seam so a unit test can supply a stub context value without
// the full PreferencesProvider. Application code consumes via usePreferences(),
// not this object directly. Mirrors OpenTabsContext.
export const PreferencesContext = createContext<PreferencesContextValue | null>(null);

// The actual preferences store: state + the GET /api/preferences fetch + the
// window-`focus` refetch listener + the apply-on-success `set`. Used in two ways:
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

  // Apply-on-success (NOT optimistic): the new value is written to local state
  // only after POST /api/preferences resolves — `set` never mutates state ahead
  // of the round-trip, so a failed save leaves the prior value in place with no
  // rollback to perform. Because it reads no state, `set` keeps a stable identity
  // across preference updates; consumers still re-render on the `preferences`
  // field changing, which is the real "value changed" signal.
  const set = useCallback(
    async (key: PreferenceKey, value: unknown) => {
      try {
        const next = await apiClient.post<PreferencesResponse>('/api/preferences', {
          [key]: value,
        });
        setPreferences(next);
        return next;
      } catch (e) {
        // Generic copy: the internal dotted-path key (`inbox.sections.awaiting-author`,
        // etc.) is a wire-format detail with no value to the end user. If a
        // consumer wants key-specific wording it can catch the rejection and
        // show its own toast.
        show({
          kind: 'error',
          message: "Couldn't save preference.",
        });
        throw e;
      }
    },
    [show],
  );

  // Memoized so an unrelated provider re-render doesn't churn every consumer
  // (mirrors OpenTabsContext.tsx). `set` and `refetch` are stable useCallbacks,
  // so the value's identity changes only when `preferences` or `error` does —
  // exactly the "value changed" signal consumers should re-render on.
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
