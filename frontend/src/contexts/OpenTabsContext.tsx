import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PrReference } from '../api/types';
import { prRefKey } from '../api/types';

export interface OpenTab {
  ref: PrReference;
  // null until PrDetailPage resolves the PR title via usePrDetail.
  // While null, PrTabStrip falls back to a "#NNNN" label.
  title: string | null;
}

export interface OpenTabsContextValue {
  openTabs: OpenTab[];
  unreadKeys: ReadonlySet<string>;
  addTab(ref: PrReference, title: string | null): void;
  setTitle(ref: PrReference, title: string): void;
  closeTab(ref: PrReference): void;
  markUnread(prRefKey: string): void;
  clearUnread(prRefKey: string): void;
  clearAllTabs(): void;
}

const Ctx = createContext<OpenTabsContextValue | null>(null);

export function OpenTabsProvider({ children }: { children: ReactNode }) {
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [unreadKeys, setUnreadKeys] = useState<ReadonlySet<string>>(() => new Set());

  // Ref mirror of `openTabs` so `markUnread` can read the latest tab list
  // synchronously inside the same batch as `addTab` without depending on it
  // via useCallback (which would only refresh on next render). Without this,
  // `addTab(ref) + markUnread(prRefKey(ref))` in one batch would short-circuit
  // because the closure-read `openTabs` array is still the pre-batch snapshot.
  const openTabsRef = useRef<OpenTab[]>(openTabs);

  const addTab = useCallback((ref: PrReference, title: string | null) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => {
      if (prev.some((t) => prRefKey(t.ref) === key)) return prev;
      const next = [...prev, { ref, title }];
      openTabsRef.current = next;
      return next;
    });
  }, []);

  const setTitle = useCallback((ref: PrReference, title: string) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => {
      const next = prev.map((t) => (prRefKey(t.ref) === key ? { ...t, title } : t));
      openTabsRef.current = next;
      return next;
    });
  }, []);

  const closeTab = useCallback((ref: PrReference) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => {
      const next = prev.filter((t) => prRefKey(t.ref) !== key);
      openTabsRef.current = next;
      return next;
    });
    setUnreadKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Reads the latest `openTabs` from the ref mirror to filter out keys not
  // currently open. The ref is updated synchronously inside the addTab /
  // setTitle / closeTab / clearAllTabs updaters so a same-batch
  // addTab + markUnread (test case 5) sees the tab as present.
  //
  // Why not read `openTabs` via useCallback deps? Closure-read snapshots the
  // pre-batch tabs array, so same-batch addTab + markUnread short-circuits.
  // Why not nest setOpenTabs((prev) => { setUnreadKeys(...); return prev; })?
  // Nested setState inside another updater is a React anti-pattern: StrictMode
  // double-invocation can drop or duplicate the inner call. The ref mirror
  // sidesteps both pitfalls.
  const markUnread = useCallback((key: string) => {
    if (!openTabsRef.current.some((t) => prRefKey(t.ref) === key)) return;
    setUnreadKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const clearUnread = useCallback((key: string) => {
    setUnreadKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const clearAllTabs = useCallback(() => {
    setOpenTabs([]);
    openTabsRef.current = [];
    setUnreadKeys(new Set());
  }, []);

  // identity-changed → clear all open tabs. The existing api/events.ts
  // WINDOW_EVENT_BRIDGE re-dispatches every identity-changed SSE frame as a
  // 'prism-identity-changed' window event. useAuth.ts already consumes that
  // bridge at App level — we listen on the same bridge here to avoid adding a
  // second useEventSource subscriber for an event that already has a window
  // bridge. OpenTabsProvider is mounted OUTSIDE EventStreamProvider in App.tsx,
  // so it can't call useEventSource() directly — the window bridge is the
  // intended cross-provider API for this event.
  useEffect(() => {
    const onIdentityChange = () => clearAllTabs();
    window.addEventListener('prism-identity-changed', onIdentityChange);
    return () => window.removeEventListener('prism-identity-changed', onIdentityChange);
  }, [clearAllTabs]);

  const value = useMemo(
    () => ({
      openTabs,
      unreadKeys,
      addTab,
      setTitle,
      closeTab,
      markUnread,
      clearUnread,
      clearAllTabs,
    }),
    [openTabs, unreadKeys, addTab, setTitle, closeTab, markUnread, clearUnread, clearAllTabs],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenTabs(): OpenTabsContextValue {
  const v = useContext(Ctx);
  if (v == null) {
    throw new Error('useOpenTabs must be used inside OpenTabsProvider');
  }
  return v;
}
