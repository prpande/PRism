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
  | 'inbox.sectionOrder'
  | 'inbox.showActivityRail'
  | 'inbox.groupByRepo'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'recently-closed'}`;

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
