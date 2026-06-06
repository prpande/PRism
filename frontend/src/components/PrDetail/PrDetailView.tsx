import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { PrDetailSkeleton } from './PrDetailSkeleton';
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
import { useTopProgress } from '../../contexts/LoadingBarContext';
import { useActivationTransition } from '../../hooks/useActivationTransition';
import { ErrorModal } from '../ErrorModal';
import bannerReconcileStyles from './BannerReconcile.module.css';

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
  const navigate = useNavigate();

  const { data, isLoading, error, reload } = usePrDetail(prRef);
  // Only the active (route-matched) tab feeds the global bar; hidden keep-alive
  // tabs pass false. Per-instance key so two mounted views never collide.
  useTopProgress(`pr-detail:${refKey}`, active && isLoading);
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
  // Depend on the stable `draftSession.refetch` (a useCallback keyed on
  // prRef/isOpen) rather than the whole `draftSession` object, which is a fresh
  // literal every render. Narrowing the dep keeps this callback — and
  // useReconcile's onReloadComplete — referentially stable across renders.
  const handleReconcileComplete = useCallback(() => {
    void draftSession.refetch();
  }, [draftSession.refetch]);
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
  // clears under keep-alive). `clearUnread` is a useCallback([]) from
  // OpenTabsContext, so it's referentially stable for the provider's lifetime —
  // the empty deps array can't go stale. ESLint's react-hooks plugin is not
  // enabled in this config, so no disable directive is needed.
  useEffect(() => {
    clearUnread(refKey);
  }, []);

  // Re-activation freshness: when the user switches BACK to this kept-alive
  // tab (the false->true transition of `active`), re-GET the detail and clear
  // the unread dot. useActivationTransition never fires on first mount, so the
  // one-shot effect above owns first-open and this owns re-activation; the two
  // paths don't double up. clearUnread is idempotent on an already-clear key,
  // and reload() is usePrDetail's re-GET + re-stamp-mark-viewed.
  useActivationTransition(active, () => {
    reload();
    clearUnread(refKey);
    // OQ8: the focus-refetch supersedes any latched "PR updated" banner — drop
    // it so it doesn't linger as a redundant Reload affordance.
    updates.clear();
  });

  // Sub-tab state replaces the URL-derived activeTab. `visited` seeds with
  // overview plus the initial sub-tab so a deep-linked open mounts that tab
  // immediately; each selectSubTab marks its target visited so it stays
  // mounted-but-hidden thereafter (keep-alive).
  //
  // `initialSubTab` is read ONCE, here, as the useState seed — React ignores
  // it on every later render. So re-navigating to an already-open tab (e.g.
  // following `…/7/overview` while PR #7 is already open on Files) keeps the
  // live sub-tab; the incoming segment does NOT re-seed. That is deliberate:
  // sub-tab clicks intentionally don't change the URL (keep-alive owns the
  // sub-tab), so honoring a stale path segment on re-entry would fight the
  // live state. Re-seeding on re-navigation is explicitly deferred — deep-link
  // sharing is a non-goal for this local-only tool (spec § 2).
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
    // Only the ACTIVE view manages the shared marker. Inactive views must NOT
    // run the body — otherwise, with 2+ open tabs, an inactive view whose effect
    // happens to run after the active view's would clear the marker the active
    // Files view just set (whichever toggles last wins). Early-returning for
    // inactive views means at most one view (the active one) ever writes the
    // marker, so there is no last-writer race across mounted tabs.
    if (!active) return;
    const slot = document.querySelector('[data-app-scroll]');
    if (!slot) return;
    slot.toggleAttribute('data-files-active', subTab === 'files');
    // Cleanup runs on deactivation / sub-tab change; the next active view's
    // setup (which runs after all cleanups in the commit) re-stamps correctly.
    return () => {
      slot.removeAttribute('data-files-active');
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
        loading={!data && isLoading}
        title={data?.pr.title ?? ''}
        author={data?.pr.author ?? ''}
        avatarUrl={data?.pr.avatarUrl}
        htmlUrl={data?.pr.htmlUrl}
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
        <div role="alert" className="banner banner-danger">
          <span className={bannerReconcileStyles.bannerReconcileMessage}>{reconcile.banner}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reconcile.clearBanner}>
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
        <ErrorModal
          open={active}
          title="Couldn't load this PR"
          message={error.message}
          dismissible
          onClose={() => navigate('/')}
          actions={
            <>
              <button
                type="button"
                className="btn btn-primary"
                data-modal-role="primary"
                onClick={handleReload}
              >
                Reload
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/')}>
                Back to inbox
              </button>
            </>
          }
        />
      )}
      {/* #180 — gate the page skeleton on the ABSENCE of data. On a same-PR
          background reload (re-activation freshness or the manual Reload
          button) usePrDetail keeps `data` present but flips isLoading; the
          GET routinely exceeds useDelayedLoading's 100ms threshold so
          isLoading goes true. The old `showSkeleton ? skeleton : data ?...`
          gate let the skeleton WIN over present data, unmounting this whole
          subtree (Overview/Files/Drafts) and destroying each tab's local state
          + inner scroll — defeating keep-alive. Gating on `!data` keeps content
          mounted during a background refresh (it updates in place); the skeleton
          shows only on a genuine first load / PR-navigation, where data is null. */}
      {!data && isLoading ? (
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
