import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PrDetailContextProvider } from './prDetailContext';
import type { PrDetailContextValue } from './prDetailContext';
import { PrHeader } from './PrHeader';
import { BannerRefresh } from './BannerRefresh';
import { BannerTransition } from './BannerTransition';
import { CrossTabPresenceBanner } from './CrossTabPresenceBanner';
import { UnresolvedPanel } from './Reconciliation/UnresolvedPanel';
import { OverviewTab } from './OverviewTab/OverviewTab';
import { FilesTab } from './FilesTab/FilesTab';
import { DraftsTabRoute } from './DraftsTab/DraftsTabRoute';
import type { PrTabId } from './PrSubTabStrip';
import { usePrDetail } from '../../hooks/usePrDetail';
import { useActivePrUpdates } from '../../hooks/useActivePrUpdates';
import { useDraftSession } from '../../hooks/useDraftSession';
import { useStateChangedSubscriber } from '../../hooks/useStateChangedSubscriber';
import { useRootCommentPostedSubscriber } from '../../hooks/useRootCommentPostedSubscriber';
import { useCrossTabPrPresence } from '../../hooks/useCrossTabPrPresence';
import { useReconcile } from '../../hooks/useReconcile';
import type { PrReference } from '../../api/types';
import { prRefKey } from '../../api/types';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { useTabScrollMemory } from '../../hooks/useTabScrollMemory';

// Keep-alive PR-detail view. Owns the active sub-tab as component STATE (not
// URL routing) and renders sub-tabs DIRECTLY (not via React Router <Outlet>),
// keeping each visited sub-tab mounted-but-hidden so its scroll position and
// in-flight composer state survive a tab switch. Extracted from the legacy
// PrDetailPageInner; `prRef` now arrives as a prop (from the host's openTabs
// entry) rather than being reconstructed from useParams(), because a hidden
// keep-alive view has no matched route.
//
// `active` only drives the top-level `hidden` attribute here. The richer
// activation transition (useActivationTransition) is wired by the host in a
// later task. The `addTab` registration likewise moves to the host; this view
// keeps `setTitle` (fill the tab title once the detail resolves) and a
// one-shot `clearUnread` on first mount.
export function PrDetailView({
  prRef,
  active,
  initialSubTab,
}: {
  prRef: PrReference;
  active: boolean;
  initialSubTab?: PrTabId;
}) {
  const { owner, repo, number } = prRef;
  const refKey = prRefKey(prRef);

  const { data, showSkeleton, error, reload } = usePrDetail(prRef);
  const updates = useActivePrUpdates(prRef);
  const draftSession = useDraftSession(prRef);
  // Refetch draft session when other tabs / the reload pipeline mutate
  // drafts. Own-tab events are filtered by the subscriber per spec § 5.7.
  useStateChangedSubscriber({ prRef, onSessionChange: draftSession.refetch });
  // Task 14: reload PR detail when the root-comment draft is posted so the
  // posted comment appears in the conversation and the local draft clears.
  useRootCommentPostedSubscriber({ prRef, onPosted: reload });
  const presence = useCrossTabPrPresence(prRef);

  // Wraps POST /api/pr/{ref}/reload with the spec's 409-stale-head auto-retry.
  // Wired alongside usePrDetail.reload — the two reload paths address
  // different concerns (PR-detail refetch vs. draft reconciliation) and run
  // concurrently when the user clicks the Reload button.
  const handleReconcileComplete = useCallback(() => {
    void draftSession.refetch();
  }, [draftSession]);
  const reconcile = useReconcile({
    prRef,
    headSha: data?.pr.headSha ?? null,
    onReloadComplete: handleReconcileComplete,
  });

  // Open-tabs integration. setTitle fills in the tab title once usePrDetail
  // resolves it; clearUnread fires once on first mount. addTab moved to the
  // host (a hidden keep-alive view should not register itself).
  const { setTitle, clearUnread } = useOpenTabs();

  // Fill in the title once usePrDetail resolves it. Skipped while title is
  // still null/undefined (initial load + error states). Deps are primitives,
  // not the `prRef` object literal, so the effect doesn't re-fire on every
  // render.
  useEffect(() => {
    if (data?.pr.title) {
      setTitle({ owner, repo, number }, data.pr.title);
    }
  }, [data?.pr.title, setTitle, owner, repo, number]);

  // One-shot: clear unread on first mount of this view. The host owns
  // focus-driven clears under keep-alive; here we just ensure a freshly
  // opened view starts read.
  // refKey/clearUnread are intentionally omitted: this is a one-shot first-mount
  // clear, not a re-fire on every refKey change (the host owns focus-driven
  // clears under keep-alive). ESLint's react-hooks plugin is not enabled in this
  // config, so no disable directive is needed.
  useEffect(() => {
    clearUnread(refKey);
  }, []);

  // Sub-tab state replaces the URL-derived activeTab. `visited` seeds with
  // overview plus the initial sub-tab so a deep-linked open mounts that tab
  // immediately; each selectSubTab marks its target visited so it stays
  // mounted-but-hidden thereafter (keep-alive).
  const seed = initialSubTab ?? 'overview';
  const [subTab, setSubTab] = useState<PrTabId>(seed);
  const visited = useRef<Set<PrTabId>>(new Set<PrTabId>(['overview', seed]));
  const selectSubTab = useCallback((tab: PrTabId) => {
    visited.current.add(tab);
    setSubTab(tab);
  }, []);

  // Ordering dependency: the marker effect must precede useTabScrollMemory so
  // [data-app-scroll] is a scroll container before scrollTop is restored (in
  // browser mode it's only scrollable when data-files-active is set; writing
  // scrollTop to a non-scrollable element clamps to 0). React runs layout-effect
  // setups in declaration order, so on Files re-activation this effect turns on
  // overflow first, then useTabScrollMemory restores the saved offset.

  // Viewport-bound Files layout marker. Under keep-alive every open PR tab keeps
  // a (hidden) Files sub-tab in the DOM, so the layout can no longer key off the
  // mere presence of `.files-tab`. Instead THIS view stamps a `data-files-active`
  // marker on the shared [data-app-scroll] container only while it is the active
  // view (route-matched) AND showing Files; the tokens.css rules scoped to that
  // marker bind the shell to the viewport so the diff scrolls internally with a
  // bottom-of-screen horizontal scrollbar (#191/#156). The cleanup removes the
  // marker when this view deactivates or switches sub-tab, so a different active
  // view (or a non-Files tab) reverts to normal document scroll. ESLint's
  // react-hooks plugin is not enabled in this config, so no disable directive is
  // needed for the deps array.
  useLayoutEffect(() => {
    const slot = document.querySelector('[data-app-scroll]');
    if (!slot) return;
    const on = active && subTab === 'files';
    slot.toggleAttribute('data-files-active', on);
    return () => {
      if (on) slot.removeAttribute('data-files-active');
    };
  }, [active, subTab]);

  // Save/restore per-(prRef, subTab) scroll offset on the shared [data-app-scroll]
  // scroller. Cleanup-before-setup ordering ensures the outgoing view's offset is
  // persisted before the incoming view restores its own — no cross-view race.
  // Declared AFTER the data-files-active marker effect above so the container is
  // already a scroller when this restores scrollTop (see ordering note above).
  useTabScrollMemory({ prRefKey: refKey, subTab, active });

  const handleReload = () => {
    updates.clear();
    reload();
    // Skip the reconcile leg when a peer tab claimed cross-tab ownership;
    // POST /reload is a mutating write and would race the claiming tab.
    // usePrDetail.reload() is a pure GET-refresh of the PR detail and stays.
    if (!presence.readOnly) {
      void reconcile.reload();
    }
  };

  const currentIter = data?.iterations?.at(-1)?.number ?? 0;
  const draftsCount =
    (draftSession.session?.draftComments.length ?? 0) +
    (draftSession.session?.draftReplies.length ?? 0);

  // Live merge/close transition (spec § 5.2.3): the SSE event reports the PR is
  // now done, but the loaded detail still shows it open (the user hasn't reloaded).
  // That gap IS the "transitioned while viewing" signal. After Reload, data.pr flips
  // done and this self-clears (read-only view takes over). The `data &&` guard
  // prevents a banner flash when an SSE done-event arrives before the initial
  // detail GET resolves.
  const detailIsDone = data?.pr.isMerged === true || data?.pr.isClosed === true;
  const transitionState: 'merged' | 'closed' | null =
    data && !detailIsDone && updates.isMerged
      ? 'merged'
      : data && !detailIsDone && updates.isClosed
        ? 'closed'
        : null;

  // #116 — auto-transition to read-only on a background merge/close without a
  // manual Reload click. Keyed by refKey so it fires at most once per PR (and
  // re-arms on PR navigation). The merge/close banner stays as a visible
  // backstop until data.pr actually flips, then self-clears.
  const autoReloadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (transitionState !== null && autoReloadedForRef.current !== refKey) {
      autoReloadedForRef.current = refKey;
      reload();
    }
  }, [transitionState, refKey, reload]);

  // read-only mode is a page-level class for visual dimming; per-leaf
  // disabled / aria-readonly on the composer textareas + action buttons carry
  // the a11y signal to assistive tech.
  const pageClassName = presence.readOnly
    ? 'pr-detail-page pr-detail-page-readonly'
    : 'pr-detail-page';

  // Provider value for the direct-rendered sub-tabs. `prDetail` is
  // non-nullable in the context shape, so this is only consumed inside the
  // `data ?` gate below where `data!` is guaranteed present. The always-visible
  // chrome (UnresolvedPanel → StaleDraftRow) gets `onSelectSubTab` as an
  // explicit prop instead, so it renders crash-free during the pre-load window
  // when `data === null`.
  const ctxValue = useMemo<PrDetailContextValue>(
    () => ({
      prRef,
      prDetail: data!,
      draftSession,
      readOnly: presence.readOnly,
      onSelectSubTab: selectSubTab,
    }),
    [prRef, data, draftSession, presence.readOnly, selectSubTab],
  );

  return (
    <div className={pageClassName} data-prref={refKey} hidden={!active}>
      <PrHeader
        reference={prRef}
        title={data?.pr.title ?? ''}
        author={data?.pr.author ?? ''}
        branchInfo={
          data ? { headBranch: data.pr.headBranch, baseBranch: data.pr.baseBranch } : undefined
        }
        mergeability={data?.pr.mergeability}
        ciSummary={data?.pr.ciSummary}
        activeTab={subTab}
        onTabChange={selectSubTab}
        draftsCount={draftsCount}
        session={draftSession.session}
        headShaDrift={updates.headShaChanged}
        currentHeadSha={data?.pr.headSha}
        prState={data?.pr.isMerged ? 'merged' : data?.pr.isClosed ? 'closed' : 'open'}
        mergedAt={data?.pr.mergedAt}
        closedAt={data?.pr.closedAt}
        readOnly={presence.readOnly}
        registerOpenComposer={draftSession.registerOpenComposer}
        getPrRootHolder={draftSession.getPrRootHolder}
        onSessionRefetch={() => void draftSession.refetch()}
      />
      <CrossTabPresenceBanner
        visible={presence.showBanner}
        readOnly={presence.readOnly}
        onSwitchToOther={presence.switchToOther}
        onTakeOver={presence.takeOver}
        onDismiss={presence.dismissForSession}
      />
      {reconcile.banner && (
        <div role="alert" className="reload-error-banner">
          <span>{reconcile.banner}</span>
          <button type="button" onClick={reconcile.clearBanner}>
            Dismiss
          </button>
        </div>
      )}
      {/* Like BannerRefresh, this stays visible (Reload active) for a passive cross-tab
          readOnly viewer; handleReload already no-ops the reconcile leg when readOnly. */}
      {transitionState ? (
        <BannerTransition state={transitionState} onReload={handleReload} />
      ) : (
        <BannerRefresh
          hasUpdate={updates.hasUpdate}
          headShaChanged={updates.headShaChanged}
          commentCountDelta={updates.commentCountDelta}
          currentIterationNumber={currentIter}
          onReload={handleReload}
          onDismiss={updates.clear}
        />
      )}
      <UnresolvedPanel
        prRef={prRef}
        session={draftSession.session}
        onMutated={() => void draftSession.refetch()}
        readOnly={presence.readOnly}
        onSelectSubTab={selectSubTab}
      />
      {error && (
        <div role="alert" className="pr-detail-error">
          Couldn't load PR — {error.message}
        </div>
      )}
      {showSkeleton ? (
        <PrDetailSkeleton />
      ) : data ? (
        // Direct keep-alive sub-tab rendering. Each visited sub-tab stays
        // mounted; `hidden` hides the inactive ones. Unvisited sub-tabs are
        // not in the DOM at all until first selected.
        <PrDetailContextProvider value={ctxValue}>
          {visited.current.has('overview') && (
            <div data-subtab="overview" hidden={subTab !== 'overview'}>
              <OverviewTab />
            </div>
          )}
          {visited.current.has('files') && (
            <div data-subtab="files" hidden={subTab !== 'files'}>
              <FilesTab />
            </div>
          )}
          {visited.current.has('drafts') && (
            <div data-subtab="drafts" hidden={subTab !== 'drafts'}>
              <DraftsTabRoute />
            </div>
          )}
        </PrDetailContextProvider>
      ) : null}
    </div>
  );
}

function PrDetailSkeleton() {
  return (
    <div className="pr-detail-skeleton" aria-busy="true" aria-live="polite">
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row skeleton-row-tall" />
    </div>
  );
}
