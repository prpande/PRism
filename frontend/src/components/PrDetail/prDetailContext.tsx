import { createContext, useContext, type ReactNode } from 'react';
import type { PrDetailDto, PrReference, MergeReadiness } from '../../api/types';
import type { UseDraftSessionResult } from '../../hooks/useDraftSession';
import type { FileFocusState } from '../../hooks/useFileFocusResult';
import type { CheckRunsResult } from '../../hooks/useCheckRuns';
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
  baseShaChanged: boolean;
  // Switches the active sub-tab. Replaces the old navigate(`${base}/files`)
  // call sites (OverviewTab CTA, DraftsTab handleEdit, StaleDraftRow handleShowMe).
  onSelectSubTab: (tab: PrTabId) => void;
  // The single shared file-focus result (spec §8) — consumed by FileTree dots
  // AND HotspotsTab. One owner (PrDetailView) fetches it; both readers share it,
  // so there is no duplicate GET.
  fileFocus: FileFocusState;
  // The single shared check-runs result (spec §9) — consumed by the checks tab.
  // One owner (PrDetailView) fetches it; the checks tab reads it.
  checks: CheckRunsResult;
  // Deep-link navigation intent: HotspotsTab calls requestFileView(path) (which
  // switches to the Files tab and stashes the path); FilesTab consumes
  // pendingFilePath, applies it, then calls clearPendingFilePath(). The state
  // lives in PrDetailView (the value object), not this module.
  pendingFilePath: string | null;
  requestFileView: (path: string) => void;
  clearPendingFilePath: () => void;
  // Shared per-file "viewed" state (#442). Derived from the persisted
  // fileViewState (head-matched) plus an optimistic overlay; the Files-tab
  // checkboxes AND the Overview "Viewed" tile read the same Set, so a toggle in
  // one surface is reflected in the other. Owned by PrDetailView via
  // useFileViewState — no consumer keeps its own copy.
  viewedPaths: Set<string>;
  toggleViewed: (path: string) => void;
  // #566 — lets the Overview PrActionsPanel trigger a PR-detail reload (SSE-drop fallback).
  reload: () => void;
  // True while the PR detail is loading or re-fetching (usePrDetail.isLoading — set on every
  // reload, not just the first load, while keeping the stale data visible). #566 — the Overview
  // PrActionsPanel disables its lifecycle actions while this is true so a mid-update click can't
  // fire an action against a PR whose state is still settling.
  isLoading: boolean;
  // #655 — live mergeability resolved by the poller and pushed over the pr-updated SSE feed.
  // Undefined until the first mergeReadinessChanged event arrives; the panel prefers this value
  // over the frozen snapshot seed (pr.mergeReadiness) once set.
  liveMergeReadiness?: MergeReadiness;
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
