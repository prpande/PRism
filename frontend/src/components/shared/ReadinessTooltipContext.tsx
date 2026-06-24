import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface ReadinessTooltipState {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

// Exported so ReadinessBadge can detect provider presence (null = no provider).
export const ReadinessTooltipCtxRaw = createContext<ReadinessTooltipState | null>(null);

// At most one readiness popover is open at a time (spec §6 singleton). Provided once near
// the app root; each badge opens by setting openId to its own id, which closes any other.
export function ReadinessTooltipProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const value = useMemo(() => ({ openId, setOpenId }), [openId]);
  return (
    <ReadinessTooltipCtxRaw.Provider value={value}>{children}</ReadinessTooltipCtxRaw.Provider>
  );
}

export function useReadinessTooltip(): ReadinessTooltipState {
  // Degrade gracefully if a badge renders outside a provider (e.g. an isolated test):
  // behave as a no-singleton local fallback rather than throwing.
  return useContext(ReadinessTooltipCtxRaw) ?? { openId: null, setOpenId: () => {} };
}
