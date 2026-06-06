import { useCallback, useState } from 'react';

// Per-PR collapsed state for the PrHeader meta block. Session-only and
// in-memory (mirrors useTabScrollMemory's store): closing/reopening the app
// resets every PR to expanded. Keyed by prRefKey so each open PR remembers its
// own choice while the app runs — surviving sub-tab and PR-tab switches under
// keep-alive.
const store = new Map<string, boolean>();

// Test-only: reset the module-level store between Vitest files.
export function _clearStoreForTest(): void {
  store.clear();
}

// Returns [collapsed, toggle]. The seed is read ONCE — prRefKey is stable for a
// PrHeader instance's lifetime (PrTabHost keys one PrDetailView per PR), so no
// re-seed effect is needed (mirrors PrDetailView's initialSubTab seed-once
// pattern).
export function usePrHeaderCollapsed(prRefKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => store.get(prRefKey) ?? false);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      store.set(prRefKey, next);
      return next;
    });
  }, [prRefKey]);

  return [collapsed, toggle];
}
