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
import { HotspotsTab } from './HotspotsTab/HotspotsTab';
import { DraftsTabRoute } from './DraftsTab/DraftsTabRoute';
import { ChecksTab } from './ChecksTab/ChecksTab';
import { checksGlyphState } from './checksGlyphState';
import { PrDetailSkeleton } from './PrDetailSkeleton';
import type { PrTabId } from './PrSubTabStrip';
import { usePrDetail } from '../../hooks/usePrDetail';
import { useActivePrUpdates } from '../../hooks/useActivePrUpdates';
import { snapshot } from '../../utils/snapshotMerge';
import { usePrDetailRefresh } from '../../hooks/usePrDetailRefresh';
import { useToast } from '../Toast/useToast';
import { useDraftSession } from '../../hooks/useDraftSession';
import { useFileViewState, type FileViewRollback } from '../../hooks/useFileViewState';
import { viewedRollbackMessage } from './viewedRollbackMessage';
import { useCapabilities } from '../../hooks/useCapabilities';
import { usePreferences } from '../../hooks/usePreferences';
import { useFileFocusResult } from '../../hooks/useFileFocusResult';
import { useStateChangedSubscriber } from '../../hooks/useStateChangedSubscriber';
import { useRootCommentPostedSubscriber } from '../../hooks/useRootCommentPostedSubscriber';
import { useSingleCommentPostedSubscriber } from '../../hooks/useSingleCommentPostedSubscriber';
import { useLifecycleChangedSubscriber } from '../../hooks/useLifecycleChangedSubscriber';
import { useDraftSubmittedSubscriber } from '../../hooks/useDraftSubmittedSubscriber';
import { useCrossTabPrPresence } from '../../hooks/useCrossTabPrPresence';
import { useReconcile } from '../../hooks/useReconcile';
import type { PrReference } from '../../api/types';
import { prRefKey } from '../../api/types';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { glyphStateFor, type GlyphState } from '../shared/prStateGlyph';
import { useTabScrollMemory } from '../../hooks/useTabScrollMemory';
import { useDiffScrollRestore } from '../../hooks/diffScrollMemory';
import { useSlotScrollMemory, isSlotScrollSubTab } from '../../hooks/slotScrollMemory';
import { LoadingBar } from '../LoadingBar';
import { useCheckRuns } from '../../hooks/useCheckRuns';
import { useActivationTransition } from '../../hooks/useActivationTransition';
import { useAiFailure } from '../Ai/aiFailure';
import { fileFocusStatusToMarkerState } from '../Ai/fileFocusMarkerState';
import { ErrorModal } from '../ErrorModal';
import { MergedAnnouncer } from './MergedAnnouncer';

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
  // Root ref for #590 inner-diff-scroll restore (scopes the .diff-pane-body query
  // to THIS view's kept-alive subtree).
  const pageRef = useRef<HTMLDivElement>(null);
  // Stable callback for MergedAnnouncer so its [isMerged, onMerged] effect only
  // re-runs when isMerged changes (not on every render). pageRef is a stable
  // object so the empty dep array cannot go stale.
  const handleMerged = useCallback(() => pageRef.current?.focus(), []);

  const { clearPr } = useAiFailure();
  // Clear AI failures for this PR when the view unmounts (e.g. tab closed under PrTabHost
  // keep-alive) so a stale Retry can't fire against a PR the user has left. clearPr is a
  // stable useCallback from AiFailureProvider; prRef's primitive fields are the real deps.
  useEffect(() => {
    return () => clearPr(prRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; clearPr stable (#331)
  }, [owner, repo, number]);

  const { data, isLoading, error, reload } = usePrDetail(prRef);
  const updates = useActivePrUpdates(prRef);
  // #671 — `clear` is a stable useCallback([]), but `updates` (spread return) is a fresh
  // object each render. Bind the stable member to a local so callbacks can list it in
  // their dep arrays directly, no exhaustive-deps suppression needed.
  const clearUpdates = updates.clear;

  // The SINGLE shared file-focus fetch (spec §8): owned here, consumed by both
  // the Files-tree dots and the HotspotsTab via prDetailContext — no duplicate
  // GET. Enabled when the fileFocus capability is on (Preview OR Live); the Live
  // fetch is additionally gated on `subscribed` (D111 204 race).
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  // Preview and Live both set capabilities.fileFocus=true, so the capability flag
  // can't tell them apart — read the mode to gate the numeric badge (Preview's
  // placeholder data must not surface a count).
  const isLive = preferences?.ui?.aiMode === 'live';
  const fileFocusEnabled = capabilities?.fileFocus ?? false;
  const fileFocus = useFileFocusResult(prRef, fileFocusEnabled, updates.subscribed);

  // #344 — proactive manual Refresh. Force-re-reads the PR from GitHub (bypasses
  // the head-SHA-keyed snapshot cache), then fires usePrDetail.reload() to re-GET
  // the fresh detail and clears any latched "PR updated" banner (a manual pull
  // moots it). Errors surface as a soft, dismissible toast — the view keeps its
  // current data. Drives the header RefreshButton + the sr-only announcer below.
  const toast = useToast();
  const prRefresh = usePrDetailRefresh({
    prRef,
    reload,
    clearUpdates,
    onError: (message) => toast.show({ kind: 'error', message }),
  });

  const draftSession = useDraftSession(prRef);
  // Refetch draft session when other tabs / the reload pipeline mutate
  // drafts. Own-tab events are filtered by the subscriber per spec § 5.7.
  useStateChangedSubscriber({ prRef, onSessionChange: draftSession.refetch });

  // A failed viewed-POST rolls the checkbox back. Say so: a tick that silently un-ticks
  // itself reads as the app losing the mark rather than as a rejected write.
  const handleViewedRollback = useCallback(
    (rollback: FileViewRollback) =>
      toast.show({ kind: 'error', message: viewedRollbackMessage(rollback) }),
    [toast],
  );

  // #442 — single shared per-file "viewed" state for the Files-tab checkboxes
  // AND the Overview "Viewed" tile. Derived from the persisted fileViewState
  // (head-matched) plus an optimistic overlay; `headSha` is undefined until the
  // detail loads (the hook no-ops toggles until then).
  const { viewedPaths, toggleViewed } = useFileViewState(
    prRef,
    data?.pr.headSha,
    draftSession.session?.fileViewState?.viewedFiles,
    handleViewedRollback,
  );
  // Task 14: reload PR detail when the root-comment draft is posted so the
  // posted comment appears in the conversation and the local draft clears.
  useRootCommentPostedSubscriber({ prRef, onPosted: reload });
  // #450: when a single inline comment/reply is posted, reload PR detail so the new thread
  // surfaces with its ReplyComposer — without a manual reload. Mirrors the root-comment
  // subscriber above; the loader's matching SingleCommentPostedBusEvent → Invalidate guarantees
  // the reload re-fetches fresh detail, not the stale head-SHA-keyed snapshot.
  useSingleCommentPostedSubscriber({ prRef, onPosted: reload });
  // #566: reload PR detail when a lifecycle action (close/reopen/draft toggle) succeeds, and
  // clear the transition latch first so the acting tab does NOT flash the "PR was closed —
  // Reload" banner for its own action (mirrors handleReload's clearUpdates() + reload()).
  const handleLifecycleChanged = useCallback(() => {
    clearUpdates();
    reload();
  }, [reload, clearUpdates]);
  useLifecycleChangedSubscriber({ prRef, onChanged: handleLifecycleChanged });
  // #392: when a review is submitted, reload PR detail (so the just-posted inline
  // threads + Overview comment surface) AND refetch the draft session (so the
  // submitted drafts clear from their composers) — without a manual reload. The
  // `draft-submitted` SSE fires post-clear (PrSubmitEndpoints publishes it after the
  // pipeline's ClearSubmittedSession), and the loader's matching DraftSubmitted →
  // Invalidate guarantees this reload re-fetches fresh detail, not the stale snapshot.
  const handleDraftSubmitted = useCallback(() => {
    reload();
    void draftSession.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload (usePrDetail) and draftSession.refetch are stable useCallbacks, not the per-render draftSession object literal (#331)
  }, [reload, draftSession.refetch]);
  useDraftSubmittedSubscriber({ prRef, onSubmitted: handleDraftSubmitted });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the stable draftSession.refetch useCallback, not the per-render draftSession object literal (#331)
  }, [draftSession.refetch]);
  const reconcile = useReconcile({
    prRef,
    headSha: data?.pr.headSha ?? null,
    onReloadComplete: handleReconcileComplete,
  });

  // Open-tabs integration. setTitle fills in the tab title once usePrDetail
  // resolves it; clearUnread fires once on first mount. addTab moved to the
  // host (a hidden keep-alive view should not register itself).
  const { setTitle, setTabState, clearUnread } = useOpenTabs();

  // Fill in the title once usePrDetail resolves it. Skipped while title is
  // still null/undefined (initial load + error states). Deps are primitives,
  // not the `prRef` object literal, so the effect doesn't re-fire on every
  // render.
  useEffect(() => {
    if (data?.pr.title) {
      setTitle({ owner, repo, number }, data.pr.title);
    }
  }, [data?.pr.title, setTitle, owner, repo, number]);

  // #530 — fill the tab's leading state glyph once the PR resolves. `null` until
  // `data.pr` exists → the tab strip draws no glyph rather than a guessed one.
  // The derived `glyphState` is a primitive, so keying the effect on it (not the
  // `data` object) re-fires only when the state actually changes, not on every
  // poll-driven `data` identity change.
  const tabGlyphState: GlyphState | null = data?.pr ? glyphStateFor(data.pr) : null;
  useEffect(() => {
    if (tabGlyphState === null) return;
    setTabState({ owner, repo, number }, tabGlyphState);
  }, [tabGlyphState, setTabState, owner, repo, number]);

  // One-shot: clear unread on first mount of this view. The host owns
  // focus-driven clears under keep-alive; here we just ensure a freshly
  // opened view starts read.
  // refKey/clearUnread are intentionally omitted: this is a one-shot first-mount
  // clear, not a re-fire on every refKey change (the host owns focus-driven
  // clears under keep-alive). `clearUnread` is a useCallback([]) from
  // OpenTabsContext, so it's referentially stable for the provider's lifetime —
  // the empty deps array can't go stale.
  useEffect(() => {
    clearUnread(refKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot first-mount clear; clearUnread is a stable useCallback([]) and refKey is read once (#331)
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
    clearUpdates();
  });

  // Sub-tab state replaces the URL-derived activeTab. `visited` seeds with
  // ONLY the landed sub-tab so that tab mounts immediately; each selectSubTab
  // marks its target visited so it stays mounted-but-hidden thereafter
  // (keep-alive). Overview is NOT pre-seeded: doing so mounted a hidden
  // OverviewTab on any non-overview landing (e.g. a /files deep-link), and a
  // persisted PR-root draft makes that hidden composer auto-open and claim the
  // PR-root draft ('reply-composer'), which then disabled the Submit dialog's
  // inline Edit toggle from the Files tab — #173. Seeding only `seed` keeps the
  // active tab always mounted (subTab === seed at init, and selectSubTab adds
  // before setSubTab) so there is no empty-screen path, while Overview now
  // mounts on first actual visit. The inbox click defaults to 'overview' via
  // parsePrRoute, so the common path is unaffected.
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
  const visited = useRef<Set<PrTabId>>(new Set<PrTabId>([seed]));
  const selectSubTab = useCallback((tab: PrTabId) => {
    visited.current.add(tab);
    setSubTab(tab);
  }, []);

  // Spec §8 — the Hotspots tab exists only when the fileFocus capability is on
  // (Preview or Live). `fileFocusEnabled` derives from async-loaded
  // capabilities, so it starts false (null caps → off) and flips true once they
  // resolve — the tab and its content appear reactively at that point.
  //
  // Deep-link-while-off edge: a `/pr/.../hotspots` URL seeds subTab='hotspots'
  // (and a user can turn AI off while parked on the tab). Coerce 'hotspots' →
  // 'overview' whenever the capability is off, so the strip's active-tab and the
  // hidden-gating below agree — no blank screen, no misleading "No file changes"
  // Hotspots state. `effectiveSubTab` is what the UI renders; the underlying
  // `subTab` state is left untouched, so the live tab is restored once caps load.
  const effectiveSubTab: PrTabId = subTab === 'hotspots' && !fileFocusEnabled ? 'overview' : subTab;

  const checksActive = active && effectiveSubTab === 'checks';
  // #743 — 4th arg (prefetch) is the VIEW-level route-active flag: the initial check-runs
  // fetch fires while the user is still on Overview/Files, but keep-alive background tabs
  // never prefetch. The poll loop stays gated on checksActive. The glyph reads glyphChecks
  // (falls back to checks for the ~10 test stubs that build the result inline) so it holds
  // the prior head's verdict through a push instead of blank-flickering.
  const checks = useCheckRuns(prRef, data?.pr.headSha, checksActive, active);
  const checksDerived = useMemo(
    () => checksGlyphState(checks.glyphChecks ?? checks.checks),
    [checks.glyphChecks, checks.checks],
  );

  // Deep-link navigation intent (spec §8). HotspotsTab calls requestFileView(path):
  // switch to Files and stash the path; FilesTab consumes pendingFilePath (resets
  // the diff range, selects the file, focuses + announces), then clears it. Focus
  // moves ONCE — when FilesTab applies the path — not on the tab switch here, to
  // avoid a double screen-reader announcement (tab button, then diff region).
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [pendingThread, setPendingThread] = useState<{ path: string; threadId: string } | null>(
    null,
  );
  const requestFileView = useCallback(
    (path: string, threadId?: string) => {
      selectSubTab('files');
      setPendingFilePath(path);
      setPendingThread(threadId ? { path, threadId } : null);
    },
    [selectSubTab],
  );
  const clearPendingFilePath = useCallback(() => setPendingFilePath(null), []);
  const clearPendingThread = useCallback(() => setPendingThread(null), []);

  // ORDER MATTERS — these layout effects must stay in this sequence:
  //   1. data-files-active / data-detail-active marker effect (below)
  //   2. useTabScrollMemory (outer [data-app-scroll] offset)
  //   3. useDiffScrollRestore (inner .diff-pane-body offset, #590)
  //   4. useSlotScrollMemory restore (non-Files [data-subtab] slot offset, #643)
  // The marker effect must precede the three restores so the relevant element is a
  // scroll container before scrollTop is restored (in browser mode the container/slot
  // is only scrollable when its marker is set; writing scrollTop to a non-scrollable
  // element clamps to 0). React runs layout-effect setups in declaration order, so on
  // re-activation this effect turns on overflow first, then the restores write their
  // saved offsets back. Reordering these silently breaks restore — there's no
  // type/lint guard, only the e2e (diff-scroll-keepalive.spec.ts #590,
  // pr-detail-header-pinned.spec.ts #640) catches it at CI time.

  // Viewport-bound Files layout marker. Under keep-alive every open PR tab keeps
  // a (hidden) Files sub-tab in the DOM, so the layout can no longer key off the
  // mere presence of `.files-tab`. Instead THIS view stamps a `data-files-active`
  // marker on the shared [data-app-scroll] container only while it is the active
  // view (route-matched) AND showing Files; the tokens.css rules scoped to that
  // marker bind the shell to the viewport so the diff scrolls internally with a
  // bottom-of-screen horizontal scrollbar (#191/#156). The cleanup removes the
  // marker when this view deactivates or switches sub-tab, so a different active
  // view (or a non-Files tab) reverts to normal document scroll. The deps array
  // below is exhaustive-deps-clean now that the react-hooks plugin is wired (#331).
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
    // #640 — the same viewport-binding shell sandwich that pins the Files header
    // (data-files-active) is reused for the other scrollable sub-tabs via a
    // parallel data-detail-active marker, so their header + sub-tab strip stay
    // pinned and only the tab content scrolls. Gated to an explicit allow-list
    // (NOT `subTab !== 'files'`): Drafts and any sub-tab added later keep today's
    // document-scroll behavior until deliberately added here, because a slot-level
    // overflow scroller vs a tab's own internal scroll regions is per-tab unanalyzed.
    // isSlotScrollSubTab is the single source of the pinned allow-list, shared with
    // useSlotScrollMemory (#643) so the marker that makes the slot a scroller and the
    // restore that writes onto it can't drift. Both are computed from `effectiveSubTab`
    // — the value that actually drives slot visibility (it coerces hotspots→overview
    // when AI is off) — so the marker binds the shell for the slot the user really
    // sees, with no separate "keep the allow-list closed under the coercion" invariant.
    const pinned = isSlotScrollSubTab(effectiveSubTab);
    slot.toggleAttribute('data-files-active', effectiveSubTab === 'files');
    slot.toggleAttribute('data-detail-active', pinned);
    // Cleanup runs on deactivation / sub-tab change; the next active view's
    // setup (which runs after all cleanups in the commit) re-stamps correctly.
    // BOTH markers are removed — a leaked data-detail-active would bind the
    // inbox/other views' shell to 100dvh/overflow:hidden and break their scroll.
    return () => {
      slot.removeAttribute('data-files-active');
      slot.removeAttribute('data-detail-active');
    };
  }, [active, effectiveSubTab]);

  // Save/restore per-(prRef, subTab) scroll offset on the shared [data-app-scroll]
  // scroller. Cleanup-before-setup ordering ensures the outgoing view's offset is
  // persisted before the incoming view restores its own — no cross-view race.
  // Declared AFTER the data-files-active marker effect above so the container is
  // already a scroller when this restores scrollTop (see ordering note above).
  useTabScrollMemory({ prRefKey: refKey, subTab, active });

  // #590 — restore the INNER diff-body scroll on re-activation. useTabScrollMemory
  // above only tracks the OUTER [data-app-scroll]; the diff scrolls internally in
  // files-active mode, and deactivation's marker removal clamps that inner offset to
  // 0. DiffPane captures the live value; this writes it back. Declared AFTER the
  // marker effect (and useTabScrollMemory) so the body is bounded again when it runs.
  useDiffScrollRestore({
    rootRef: pageRef,
    refKey,
    subTab,
    active,
    suppress: pendingThread !== null,
  });

  // #643 — restore the non-Files [data-subtab] slot scroll on re-activation. For
  // Overview/Hotspots/Checks the #640 header pin makes the visible slot (not
  // [data-app-scroll]) the bounded scroller, so useTabScrollMemory above is a no-op
  // there; this captures the live slot offset and writes it back. Keyed on
  // effectiveSubTab (the value driving slot visibility). Declared last, after the
  // marker effect, so the slot is bounded again when restore runs (see ordering note).
  useSlotScrollMemory({ rootRef: pageRef, refKey, subTab: effectiveSubTab, active });

  const handleReload = () => {
    clearUpdates();
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
      subscribed: updates.subscribed,
      baseShaChanged: updates.baseShaChanged,
      onSelectSubTab: selectSubTab,
      fileFocus,
      checks,
      pendingFilePath,
      pendingThread,
      requestFileView,
      clearPendingFilePath,
      clearPendingThread,
      viewedPaths,
      toggleViewed,
      reload,
      isLoading,
      liveMergeReadiness: updates.mergeReadiness,
      prUpdatedSignal: updates.prUpdatedSignal,
    }),
    [
      prRef,
      data,
      draftSession,
      presence.readOnly,
      updates.subscribed,
      updates.baseShaChanged,
      updates.mergeReadiness,
      updates.prUpdatedSignal,
      selectSubTab,
      fileFocus,
      checks,
      pendingFilePath,
      pendingThread,
      requestFileView,
      clearPendingFilePath,
      clearPendingThread,
      viewedPaths,
      toggleViewed,
      reload,
      isLoading,
    ],
  );

  // Hotspots tab-label cue mirrors the file-tree header reduction (spec §3): working
  // while focus loads, idle once resolved, hidden on error/no-changes/off. Gate on the
  // SAME capability flag that drives showHotspots so the tab marker and the tab presence
  // stay in lockstep (avoid divergence between fileFocusEnabled and showHotspots).
  const hotspotsAiState = fileFocusEnabled ? fileFocusStatusToMarkerState(fileFocus.status) : null;

  // Stable identity for PrHeader's onSessionRefetch — an inline arrow would hand
  // PrHeader a fresh function each render, churning its effect/memo dep hygiene.
  const handleSessionRefetch = useCallback(() => {
    void draftSession.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the stable draftSession.refetch useCallback, not the per-render draftSession object literal (#331)
  }, [draftSession.refetch]);

  return (
    <div
      ref={pageRef}
      className={pageClassName}
      data-prref={refKey}
      hidden={!active}
      data-pr-main
      tabIndex={-1}
    >
      {/* Per-tab loading bar pinned to THIS tab's content boundary (not a global
          screen-top bar) — each open PR tab owns its own. Shows on cold load and
          background reload; self-contained, so no layout shift. */}
      <LoadingBar
        active={active && (isLoading || prRefresh.isRefreshing)}
        data-testid={`pr-loading-bar:${refKey}`}
      />
      {/* #344 — sr-only live region announcing manual-refresh progress/completion
          ("Refreshing PR…" → "PR refreshed"). The RefreshButton's icon morphs are
          aria-hidden, so this status region carries the state change to assistive
          tech. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="pr-refresh-status">
        {prRefresh.announce}
      </div>
      {/* #566 §4a — SR announcement + focus contract on merge. Lives here (not in
          PrActionsPanel) because PrActionsPanel unmounts when isMerged becomes true.
          On a live false→true transition: announces "Pull request merged" first
          (polite queue), then moves focus to pageRef on the next animation frame. */}
      <MergedAnnouncer isMerged={data?.pr.isMerged ?? false} onMerged={handleMerged} />
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
        mergeReadiness={updates.mergeReadiness ?? data?.pr.mergeReadiness}
        approvals={snapshot(updates.approvals, data?.pr.approvals)}
        changesRequested={snapshot(updates.changesRequested, data?.pr.changesRequested)}
        updatedAt={data?.pr.updatedAt}
        approvers={snapshot(updates.approvers, data?.pr.approvers)}
        changesRequestedBy={snapshot(updates.changesRequestedBy, data?.pr.changesRequestedBy)}
        awaitingReviewers={snapshot(updates.awaitingReviewers, data?.pr.awaitingReviewers)}
        ciSummary={data?.pr.ciSummary}
        activeTab={effectiveSubTab}
        onTabChange={selectSubTab}
        showHotspots={fileFocusEnabled}
        hotspotsAiState={hotspotsAiState}
        draftsCount={draftsCount}
        checksLead={checksDerived.lead}
        checksFailingCount={checksDerived.failingCount}
        checksAriaLabel={checksDerived.ariaSummary}
        hotspotsCount={
          // Only a real (Live) ranking with signal gets a numeric badge. Preview
          // (placeholder data) + loading/empty/error/fallback/no-changes/
          // not-subscribed all suppress the count.
          isLive && fileFocus.status === 'ok'
            ? fileFocus.entries.filter((e) => e.level === 'high' || e.level === 'medium').length
            : undefined
        }
        session={draftSession.session}
        headShaDrift={updates.headShaChanged}
        currentHeadSha={data?.pr.headSha}
        prState={data?.pr.isMerged ? 'merged' : data?.pr.isClosed ? 'closed' : 'open'}
        isDraft={data?.pr.isDraft ?? false}
        mergedAt={data?.pr.mergedAt}
        closedAt={data?.pr.closedAt}
        readOnly={presence.readOnly}
        registerOpenComposer={draftSession.registerOpenComposer}
        getPrRootHolder={draftSession.getPrRootHolder}
        onSessionRefetch={handleSessionRefetch}
        onRefresh={prRefresh.refresh}
        isRefreshing={prRefresh.isRefreshing}
        justRefreshed={prRefresh.justRefreshed}
        viewerReview={data?.viewerReview}
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
          <span className="banner-message">{reconcile.banner}</span>
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
          onDismiss={clearUpdates}
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
          button) usePrDetail keeps `data` present but flips `isLoading` true.
          Gating the skeleton on `isLoading` alone would let it WIN over present
          data, unmounting this whole subtree (Overview/Files/Drafts) and
          destroying each tab's local state + inner scroll — defeating
          keep-alive. The `!data &&` guard keeps content mounted during a
          background refresh (it updates in place); the skeleton shows only on a
          genuine first load / PR-navigation, where data is null. (The bar above
          covers the background-reload case visually.) */}
      {!data && isLoading ? (
        <PrDetailSkeleton />
      ) : ctxValue ? (
        // Direct keep-alive sub-tab rendering. Each visited sub-tab stays
        // mounted; `hidden` hides the inactive ones. Unvisited sub-tabs are
        // not in the DOM at all until first selected. Gated on `ctxValue` (non-null
        // iff `data` is) so the provider value is typed non-null without an assertion.
        <PrDetailContextProvider value={ctxValue}>
          {/* effectiveSubTab is what drives visibility (spec §8): when the
              fileFocus capability is off it coerces 'hotspots'→'overview', so a
              /hotspots deep-link landed while AI is off falls back to Overview.
              The `|| effectiveSubTab === 'overview'` term mounts Overview as the
              safe fallback even when it was never visited (the deep-link case
              seeds `visited` with only 'hotspots'), avoiding a blank screen. */}
          {(visited.current.has('overview') || effectiveSubTab === 'overview') && (
            <div data-subtab="overview" hidden={effectiveSubTab !== 'overview'}>
              <OverviewTab />
            </div>
          )}
          {visited.current.has('files') && (
            <div data-subtab="files" hidden={effectiveSubTab !== 'files'}>
              <FilesTab />
            </div>
          )}
          {/* Content gated on the capability too (not just the tab strip): when
              AI is off no HotspotsTab mounts, so its misleading "No file changes"
              state can never surface from a coerced/deep-linked subTab. */}
          {fileFocusEnabled && visited.current.has('hotspots') && (
            <div data-subtab="hotspots" hidden={effectiveSubTab !== 'hotspots'}>
              <HotspotsTab />
            </div>
          )}
          {visited.current.has('drafts') && (
            <div data-subtab="drafts" hidden={effectiveSubTab !== 'drafts'}>
              <DraftsTabRoute />
            </div>
          )}
          {(visited.current.has('checks') || effectiveSubTab === 'checks') && (
            <div data-subtab="checks" hidden={effectiveSubTab !== 'checks'}>
              <ChecksTab />
            </div>
          )}
        </PrDetailContextProvider>
      ) : null}
    </div>
  );
}
