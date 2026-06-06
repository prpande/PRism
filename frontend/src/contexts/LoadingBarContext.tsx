import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface LoadingBarStore {
  /** Set or clear a named loading source. The bar is active when ANY source is true. */
  setLoading(key: string, active: boolean): void;
  active: boolean;
}

const LoadingBarContext = createContext<LoadingBarStore | null>(null);

// Module-level no-op store for the no-provider fallback. Hoisted (not built per
// call) so its `setLoading` identity is STABLE across renders — otherwise a
// feeder rendered outside the provider (e.g. PrDetailView in unit tests) would
// re-run useTopProgress's effect every render because `setLoading` is in its deps.
const NOOP_STORE: LoadingBarStore = { setLoading: () => {}, active: false };

export function LoadingBarProvider({ children }: { children: ReactNode }) {
  // A keyed boolean map. Boolean-per-source (not a counter) is idempotent, so a
  // StrictMode setup->cleanup->setup double-invoke nets to the correct value and
  // no key can get "stuck" from miscounting.
  const [keys, setKeys] = useState<Record<string, boolean>>({});

  const setLoading = useCallback((key: string, active: boolean) => {
    setKeys((prev) => {
      if (!!prev[key] === active) return prev; // no-op: avoids a needless re-render
      const next = { ...prev };
      if (active) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);

  const value = useMemo<LoadingBarStore>(
    () => ({ setLoading, active: Object.keys(keys).length > 0 }),
    [setLoading, keys],
  );

  return <LoadingBarContext.Provider value={value}>{children}</LoadingBarContext.Provider>;
}

export function useLoadingBar(): LoadingBarStore {
  const ctx = useContext(LoadingBarContext);
  if (!ctx) {
    // Lenient fallback mirrors useEventSource: a consumer outside the provider
    // (e.g. an isolated unit test of a feeder) gets a no-op store, not a throw.
    // Return the hoisted singleton so the identity is stable (see NOOP_STORE).
    return NOOP_STORE;
  }
  return ctx;
}

/**
 * Register `key` as a loading source while `active` is true. Clears the key when
 * `active` goes false OR the component unmounts. The on-change path is the
 * load-bearing clear under keep-alive (a kept-alive view re-renders with
 * active=false rather than unmounting), so the effect runs on every `active`
 * change, not only in cleanup.
 */
export function useTopProgress(key: string, active: boolean): void {
  const { setLoading } = useLoadingBar();
  useEffect(() => {
    setLoading(key, active);
    return () => setLoading(key, false);
  }, [key, active, setLoading]);
}
