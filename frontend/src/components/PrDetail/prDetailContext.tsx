import { createContext, useContext, type ReactNode } from 'react';
import type { PrDetailDto, PrReference } from '../../api/types';
import type { UseDraftSessionResult } from '../../hooks/useDraftSession';
import type { PrTabId } from './PrSubTabStrip';

// Carries everything a sub-tab needs, replacing the old Outlet context +
// useParams reconstruction. `prRef` is supplied by the view (from its
// openTabs entry), NOT derived from the URL — under keep-alive a hidden
// view has no matched route, so useParams() would return undefined.
export interface PrDetailContextValue {
  prRef: PrReference;
  prDetail: PrDetailDto;
  draftSession: UseDraftSessionResult;
  readOnly: boolean;
  // true only after the SSE subscribe POST settles (propagated from
  // useActivePrUpdates). Gates AI fetches that must not fire before the
  // subscription is established (D111 204 race guard).
  subscribed: boolean;
  // Switches the active sub-tab. Replaces the old navigate(`${base}/files`)
  // call sites (OverviewTab CTA, DraftsTab handleEdit, StaleDraftRow handleShowMe).
  onSelectSubTab: (tab: PrTabId) => void;
}

const PrDetailContext = createContext<PrDetailContextValue | null>(null);

export function PrDetailContextProvider({
  value,
  children,
}: {
  value: PrDetailContextValue;
  children: ReactNode;
}) {
  return <PrDetailContext.Provider value={value}>{children}</PrDetailContext.Provider>;
}

export function usePrDetailContext(): PrDetailContextValue {
  const v = useContext(PrDetailContext);
  if (v == null) {
    throw new Error('usePrDetailContext must be used inside PrDetailContextProvider');
  }
  return v;
}
