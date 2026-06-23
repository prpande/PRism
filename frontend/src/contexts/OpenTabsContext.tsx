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
import type { GlyphState } from '../components/shared/prStateGlyph';

export interface OpenTab {
  ref: PrReference;
  // null until PrDetailPage resolves the PR title via usePrDetail.
  // While null, PrTabStrip falls back to a "#NNNN" label.
  title: string | null;
  // #530 — open/merged/closed/draft for the leading state glyph. null until
  // PrDetailView resolves the PR (same path that fills `title`); while null the
  // tab strip draws no glyph rather than guessing (which would flash a wrong
  // state, e.g. open→merged, on resolve).
  glyphState: GlyphState | null;
}

export interface OpenTabsContextValue {
  openTabs: OpenTab[];
  unreadKeys: ReadonlySet<string>;
  addTab(ref: PrReference, title: string | null): void;
  setTitle(ref: PrReference, title: string): void;
  setTabState(ref: PrReference, glyphState: GlyphState): void;
  closeTab(ref: PrReference): void;
  markUnread(key: string): void;
  clearUnread(key: string): void;
  clearAllTabs(): void;
}

// Exported as a test seam so a unit test can supply a stub context value
// (e.g. an empty openTabs + no-op addTab) without the full OpenTabsProvider.
// Application code should consume via useOpenTabs(), not this object directly.
export const OpenTabsContext = createContext<OpenTabsContextValue | null>(null);

export function OpenTabsProvider({ children }: { children: ReactNode }) {
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [unreadKeys, setUnreadKeys] = useState<ReadonlySet<string>>(() => new Set());

  // Ref mirror of `openTabs` for `markUnread`'s synchronous existence check.
  // Each state mutator writes the freshly-computed array into the ref INSIDE
  // its setOpenTabs updater function. Under React's act() in tests, the
  // updater runs eagerly enough that a same-batch `addTab(a); markUnread(key)`
  // sequence reads the post-addTab ref — verified by the same-batch test.
  //
  // Why NOT reassign-on-render (`openTabsRef.current = openTabs` at top of
  // body): no render has occurred between the two same-batch calls, so the
  // ref would still hold the pre-batch list and markUnread would short-circuit.
  //
  // Why NOT nested setState (`setOpenTabs(prev => { setUnreadKeys(...); ... })`):
  // React StrictMode double-invokes updater functions to surface impure side
  // effects, so the nested setUnreadKeys would fire twice. The ref-write
  // inside the updater is idempotent (writes the same array reference both
  // times) so it survives StrictMode without observable effect.
  const openTabsRef = useRef<OpenTab[]>(openTabs);

  const addTab = useCallback((ref: PrReference, title: string | null) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => {
      if (prev.some((t) => prRefKey(t.ref) === key)) return prev;
      const next = [...prev, { ref, title, glyphState: null }];
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

  // #530 — fill the leading state glyph once PrDetailView resolves the PR. Mirrors
  // setTitle (same resolve path); a no-op if the tab is gone. Skips the state update
  // when the value is unchanged so a re-resolve doesn't churn a new array reference.
  const setTabState = useCallback((ref: PrReference, glyphState: GlyphState) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => {
      const target = prev.find((t) => prRefKey(t.ref) === key);
      if (!target || target.glyphState === glyphState) return prev;
      const next = prev.map((t) => (prRefKey(t.ref) === key ? { ...t, glyphState } : t));
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
  // currently open. The ref is written inside each setOpenTabs updater so a
  // same-batch addTab + markUnread sees the tab as present.
  //
  // Why not read `openTabs` via useCallback deps? Closure-read snapshots the
  // pre-batch tabs array, so same-batch addTab + markUnread short-circuits.
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
    setOpenTabs(() => {
      const next: OpenTab[] = [];
      openTabsRef.current = next;
      return next;
    });
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
      setTabState,
      closeTab,
      markUnread,
      clearUnread,
      clearAllTabs,
    }),
    [
      openTabs,
      unreadKeys,
      addTab,
      setTitle,
      setTabState,
      closeTab,
      markUnread,
      clearUnread,
      clearAllTabs,
    ],
  );

  return <OpenTabsContext.Provider value={value}>{children}</OpenTabsContext.Provider>;
}

export function useOpenTabs(): OpenTabsContextValue {
  const v = useContext(OpenTabsContext);
  if (v == null) {
    throw new Error('useOpenTabs must be used inside OpenTabsProvider');
  }
  return v;
}
