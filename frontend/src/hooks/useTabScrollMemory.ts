import { useLayoutEffect } from 'react';

// Shared across all PrDetailViews so the offset for a backgrounded (tab,subTab)
// survives while another view drives the single [data-app-scroll] scroller.
const store = new Map<string, number>();

export function useTabScrollMemory(opts: {
  prRefKey: string;
  subTab: string;
  active: boolean;
  slotSelector?: string;
}): void {
  const { prRefKey, subTab, active, slotSelector = '[data-app-scroll]' } = opts;
  const key = `${prRefKey}|${subTab}`;

  useLayoutEffect(() => {
    const slot = document.querySelector(slotSelector) as HTMLElement | null;
    if (!slot || !active) return;
    // Restore on setup (activation, or sub-tab change within an active view).
    slot.scrollTop = store.get(key) ?? 0;
    // Save in CLEANUP. React runs all cleanups before any setups within a
    // commit, so a deactivating view persists its scrollTop BEFORE the
    // activating view overwrites the single shared [data-app-scroll] — no
    // cross-view race regardless of openTabs order (this is the round-2 fix).
    // The same property handles same-view sub-tab switches: changing `subTab`
    // changes `key`, so cleanup saves the old sub-tab's offset before setup
    // restores the new one.
    return () => {
      store.set(key, slot.scrollTop);
    };
  }, [active, key, slotSelector]);
}
