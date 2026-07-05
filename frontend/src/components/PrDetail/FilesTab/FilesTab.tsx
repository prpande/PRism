import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ApiError } from '../../../api/client';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useUnionDiff } from '../../../hooks/useUnionDiff';
import { useFilesTabShortcuts } from '../../../hooks/useFilesTabShortcuts';
import { useAiGate } from '../../../hooks/useAiGate';
import { useAiHunkAnnotations } from '../../../hooks/useAiHunkAnnotations';
import { FileTree } from './FileTree';
import { deriveCommentStateByPath, deriveCommentCountsByPath } from './commentIndicatorState';
import { DiffPane } from './DiffPane';
import type { DiffMode } from './DiffPane';
import { DiffViewToggle } from './DiffViewToggle';
import { DiffSettingsMenu } from './DiffSettingsMenu';
import {
  useWholeFilePreference,
  deriveWholeFileEnabled,
  isWholeFileEligible,
} from './wholeFilePreference';
import { IterationTabStrip } from './IterationTabStrip';
import { CommitMultiSelectPicker } from './CommitMultiSelectPicker';
import { buildAllRange, anchorShaForRange } from '../range';
import { buildTree, flattenPaths } from './treeBuilder';
import { InlineCommentComposer } from '../Composer/InlineCommentComposer';
import { usePrDetailContext } from '../prDetailContext';
import { useInlineComposer } from './useInlineComposer';
import { useIsSplitCapable } from './useIsSplitCapable';
import { computeAnyOtherDraftsStaged } from '../../../hooks/useDraftSession';
import { useReviewThreadResolutionChangedSubscriber } from '../../../hooks/useReviewThreadResolutionChangedSubscriber';
import { useOptimisticComments } from './useOptimisticComments';
import { CommentCard } from '../Comment/CommentCard';
import styles from './FilesTab.module.css';
import type {
  ExistingCommentWidgetReplyContext,
  ThreadCollapseControl,
} from './DiffPane/ExistingCommentWidget';
import { ReplyDataProvider, type ReplyData } from './ReplyDataContext';

// True when the diff fetch failed specifically because the requested commit
// range is no longer reachable on GitHub (force-push GC'd the commits). The
// backend maps this to a typed 422 ProblemDetails { type: "/diff/range-unreachable" }
// (PrDetailEndpoints /diff, spec § 5.1). We render a distinct, human-readable
// message for it instead of the generic "Failed to load diff — {message}" banner.
// One message covers both the primary (base..head) and cross-iteration ranges —
// distinguishing "older iteration" wording is a possible future nicety, not built.
function isRangeUnreachable(error: Error | null): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 422) return false;
  const body = error.body;
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { type?: unknown }).type === '/diff/range-unreachable'
  );
}

export function effectiveCollapsed(
  overrides: Record<string, boolean>,
  threadId: string,
  isResolved: boolean,
): boolean {
  return overrides[threadId] ?? isResolved;
}

export function nextOverrides(
  overrides: Record<string, boolean>,
  threadId: string,
  isResolved: boolean,
): Record<string, boolean> {
  return { ...overrides, [threadId]: !(overrides[threadId] ?? isResolved) };
}

// #571 — drops threadId's override so effectiveCollapsed falls back to
// isResolved. Returns the SAME object reference when threadId isn't present
// so callers (setState) don't trigger a needless re-render.
export function clearOverride(
  overrides: Record<string, boolean>,
  threadId: string,
): Record<string, boolean> {
  if (!(threadId in overrides)) return overrides;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit; _drop is intentionally discarded
  const { [threadId]: _drop, ...rest } = overrides;
  return rest;
}

export function FilesTab() {
  const {
    prRef,
    prDetail,
    draftSession,
    readOnly,
    fileFocus,
    pendingFilePath,
    clearPendingFilePath,
    viewedPaths,
    toggleViewed,
    reload,
  } = usePrDetailContext();

  const isLowQuality = prDetail.clusteringQuality === 'low';

  // Files-tree wayfinding dots are fed by the SINGLE shared file-focus fetch
  // (spec §8), owned by PrDetailView and carried in context — no second GET.
  // The dot only renders for high/medium (FileTree's own logic), so empty /
  // fallback cases (no high/medium entries) naturally show no dots. The column
  // (its data-on flag) is visible only when AI is
  // genuinely active for this PR: `not-subscribed` is Live-without-subscription,
  // and `no-changes` is ALSO what useFileFocusResult returns when the fileFocus
  // capability is OFF entirely (AI off) — both mean "AI not active here", so the
  // column stays off for them. Preview/Live with a real (or in-flight) result
  // turns it on.
  const focusEntries = fileFocus.entries;
  const aiDotsOn = fileFocus.status !== 'not-subscribed' && fileFocus.status !== 'no-changes';

  // #508 (B1) — own the SINGLE PR-wide hunk-annotation fetch here (was inside DiffPane)
  // so both the file-tree header marker (working while annotations load) and the diff
  // pane (renders the resolved annotations) read one source. A second hook call in
  // DiffPane would double-GET — the endpoint isn't request-deduped.
  const hunkAnnotationsEnabled = useAiGate('hunkAnnotations');
  const aiHunkAnnotations = useAiHunkAnnotations(prRef, hunkAnnotationsEnabled);

  const [activeRange, setActiveRange] = useState<string>('all');
  const [selectedCommits, setSelectedCommits] = useState<string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Deep-link a11y: a single programmatic focus move to the diff region + one
  // polite live-region announcement when a pending path is applied (spec §8,
  // option b — no intermediate tab-button focus, so the SR makes ONE coherent
  // announcement of the destination).
  const diffRegionRef = useRef<HTMLDivElement>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [diffMode, setDiffMode] = useState<DiffMode>('side-by-side');
  // #115 — line-wrap is a view-wide preference (like diffMode, not per-file):
  // false = a single synthetic scrollbar shifts both split panes in lockstep
  // (useLockedPaneScroll); true = long lines soft-wrap within their pane.
  const [lineWrap, setLineWrap] = useState(false);
  const { showFullFile, setShowFullFile, failedPaths, markFailed, clearFailed } =
    useWholeFilePreference();

  const iterationGatePermits = activeRange === 'all' && selectedCommits === null;
  // wholeFileEnabled is fully derived below, after `selectedFile` is computed,
  // so it can include the file.status + file.hunks.length gates. This keeps the
  // effective flag passed to DiffPane consistent with the gear menu's helper text.

  const isSplitCapable = useIsSplitCapable();
  const effectiveDiffMode: DiffMode = !isSplitCapable ? 'unified' : diffMode;

  const handleRangeChange = useCallback((range: string) => {
    setActiveRange(range);
    setSelectedPath(null);
  }, []);

  const handleCommitsChange = useCallback((shas: string[] | null) => {
    setSelectedCommits(shas);
    setSelectedPath(null);
  }, []);
  const allRange = buildAllRange(prDetail.pr);

  const iterationRange = useMemo(() => {
    if (isLowQuality) return null;
    if (activeRange === 'all') return allRange;
    return activeRange;
  }, [isLowQuality, activeRange, allRange]);

  // #723 — a NEW inline comment anchors to the after-side commit of the range
  // on screen (the post-now path sends it as the GitHub commit_id): head on
  // "All changes", the iteration's afterSha on an older-iteration view. Null
  // iterationRange (low-quality commit-picker) falls back to head.
  const anchorSha = anchorShaForRange(iterationRange, prDetail.pr.headSha);

  const rangeDiff = useFileDiff(prRef, isLowQuality ? null : iterationRange);
  const lowAllDiff = useFileDiff(prRef, isLowQuality && selectedCommits === null ? allRange : null);
  const commitsDiff = useUnionDiff(
    prRef,
    isLowQuality && selectedCommits !== null ? selectedCommits : null,
  );

  const diff = isLowQuality ? (selectedCommits === null ? lowAllDiff : commitsDiff) : rangeDiff;

  const files = useMemo(() => diff.data?.files ?? [], [diff.data]);
  const tree = useMemo(() => buildTree(files), [files]);
  const fileList = useMemo(() => flattenPaths(tree), [tree]);

  // Deep-link from the Hotspots tab (spec §8). HotspotsTab calls requestFileView(path),
  // which switches to this tab and stashes `pendingFilePath` in context. The three
  // effects below cooperate to land on that path even when it is absent from the
  // CURRENTLY-loaded (possibly narrowed-iteration) diff and only present in the full
  // diff, without ever transiently grabbing the wrong file.

  // (1) On a NEW pendingFilePath, reset the range to 'all' so the target can appear
  //     in the full diff. Do NOT read fileList here — setActiveRange re-fires
  //     useFileDiff asynchronously; the stale list updates a render or more later.
  useEffect(() => {
    if (pendingFilePath === null) return;
    setActiveRange('all');
    setSelectedCommits(null);
  }, [pendingFilePath]);

  // (2) Apply the pending path once the FULL-range diff has settled. CRITICAL race
  //     guard: effect (1) called setActiveRange('all'), but useFileDiff refetches
  //     asynchronously — for one+ render ticks `fileList` is still the STALE narrowed
  //     list, which is NON-EMPTY, so a `fileList.length === 0` guard would NOT hold it
  //     back. Worse, `diff.isLoading` ALONE is insufficient: useFileDiff only flips
  //     isLoading=true inside its OWN post-commit effect, so in the render where
  //     effect (1) sets activeRange='all', diff.isLoading is still the STALE `false`
  //     from the just-finished narrowed fetch. A `!diff.isLoading` gate would pass
  //     PREMATURELY against the stale narrowed fileList, run the else-branch, and
  //     clear the intent before the full diff ever arrives — stranding the user on the
  //     wrong file. So we additionally require the LOADED diff to actually be the full
  //     'all' range: `diff.data?.range === allRange`. DiffDto.range echoes the range it
  //     was fetched for, and on 'all' the requested range is exactly `allRange`
  //     (buildAllRange(pr) = base..head) — so this holds only once `fileList` reflects
  //     the full diff. Both guards together: range matches the full request AND it has
  //     settled.
  useEffect(() => {
    if (pendingFilePath === null) return;
    // full-range diff not settled yet (still loading, or the still-loaded diff is the
    // stale narrowed range whose isLoading hasn't yet flipped) — wait.
    if (activeRange !== 'all' || diff.isLoading || diff.data?.range !== allRange) return;
    if (fileList.includes(pendingFilePath)) {
      setSelectedPath(pendingFilePath);
      // Single focus move + announce (option b): focus the tabIndex={-1} diff-region
      // container and announce the destination via the polite live region.
      diffRegionRef.current?.focus();
      setLiveMessage(`Navigated to ${pendingFilePath} on the Files tab.`);
    } else {
      // genuinely absent on the FULL diff (PR changed between fetch and click) — fall back.
      if (selectedPath === null || !fileList.includes(selectedPath)) setSelectedPath(fileList[0]);
    }
    clearPendingFilePath();
  }, [
    pendingFilePath,
    activeRange,
    diff.isLoading,
    diff.data?.range,
    allRange,
    fileList,
    selectedPath,
    clearPendingFilePath,
  ]);

  // (3) Auto-select the first file in tree order when none is selected, OR when the
  //     previously-selected path is no longer in the diff's file list (e.g. a pr-updated
  //     SSE shifted the diff and the user's selected file is gone). Mirrors GitHub /
  //     ADO / GitLab: landing on /files opens the first changed file rather than showing
  //     the empty-pane prompt. Re-fires after iteration or commit-multi-select changes
  //     (both reset selectedPath to null), and on orphaned-selection refreshes (preflight
  //     finding). GUARDED to no-op while a deep-link is outstanding — effect (2) owns
  //     selection then, so this must not seize fileList[0] from under it.
  useEffect(() => {
    if (pendingFilePath !== null) return; // deep-link in progress owns selection
    if (fileList.length === 0) return;
    if (selectedPath === null || !fileList.includes(selectedPath)) {
      setSelectedPath(fileList[0]);
    }
  }, [fileList, selectedPath, pendingFilePath]);

  const selectedFile = useMemo(
    () => (selectedPath ? (files.find((f) => f.path === selectedPath) ?? null) : null),
    [files, selectedPath],
  );

  const wholeFileEnabled = deriveWholeFileEnabled({
    showFullFile,
    failedPaths,
    selectedPath,
    selectedFileStatus: selectedFile?.status,
    selectedFileHunkCount: selectedFile?.hunks.length ?? 0,
    iterationGatePermits,
  });

  // Gating, split by scope (spec § Disabled / helper-text):
  const fullFileViewBlocked = !iterationGatePermits;
  const currentFileIneligible =
    selectedFile !== null && !isWholeFileEligible(selectedFile.status, selectedFile.hunks.length);
  const fullFileInertHere = showFullFile && iterationGatePermits && currentFileIneligible;
  const fullFileViewBlockedReason = fullFileViewBlocked
    ? "Whole-file view available only on the 'all' iteration view"
    : null;
  const fullFileInertReason = fullFileInertHere
    ? 'Not available for this file — still on for other files'
    : null;

  const fileThreads = useMemo(
    () => (selectedPath ? prDetail.reviewComments.filter((t) => t.filePath === selectedPath) : []),
    [prDetail.reviewComments, selectedPath],
  );

  // #513 — per-file comment indicator state. Reactive for free: posting/resolving a
  // thread updates prDetail.reviewComments → this recomputes → the tree glyph updates.
  const commentStateByPath = useMemo(
    () => deriveCommentStateByPath(prDetail.reviewComments),
    [prDetail.reviewComments],
  );
  // #513 — per-file thread tallies for the comment-glyph hover tooltip (open/resolved).
  const commentCountsByPath = useMemo(
    () => deriveCommentCountsByPath(prDetail.reviewComments),
    [prDetail.reviewComments],
  );

  const htmlUrl = prDetail.pr.htmlUrl ?? undefined;

  const handleNextFile = useCallback(() => {
    if (fileList.length === 0) return;
    const idx = selectedPath ? fileList.indexOf(selectedPath) : -1;
    const next = (idx + 1) % fileList.length;
    setSelectedPath(fileList[next]);
  }, [fileList, selectedPath]);

  const handlePrevFile = useCallback(() => {
    if (fileList.length === 0) return;
    const idx = selectedPath ? fileList.indexOf(selectedPath) : -1;
    if (idx <= 0) {
      setSelectedPath(fileList[fileList.length - 1]);
    } else {
      setSelectedPath(fileList[idx - 1]);
    }
  }, [fileList, selectedPath]);

  const handleToggleDiffMode = useCallback(() => {
    if (!isSplitCapable) return;
    setDiffMode((prev) => (prev === 'side-by-side' ? 'unified' : 'side-by-side'));
  }, [isSplitCapable]);

  const handleWholeFileFailed = useCallback(
    (reason: string) => {
      // `reason` is part of the onWholeFileFailed callback contract (DiffPane
      // passes the failure reason string) but unused here: DiffPane's own local
      // latch holds the reason and renders the WholeFileFailureBanner. FilesTab
      // only needs to know that the current file's whole-file fetch failed so it
      // can add the path to failedPaths and let deriveWholeFileEnabled fall back.
      void reason;
      if (!selectedPath) return;
      markFailed(selectedPath);
    },
    [selectedPath, markFailed],
  );

  // #510: banner Retry — drop the current file from failedPaths so
  // deriveWholeFileEnabled re-permits whole-file view and the fetch re-attempts.
  // Scoped to this path so a retry doesn't disturb other files' fallback state.
  const handleWholeFileRetry = useCallback(() => {
    if (!selectedPath) return;
    clearFailed(selectedPath);
  }, [selectedPath, clearFailed]);

  useFilesTabShortcuts({
    onNextFile: handleNextFile,
    onPrevFile: handlePrevFile,
    onToggleViewed: () => {
      if (selectedPath) toggleViewed(selectedPath);
    },
    onToggleDiffMode: handleToggleDiffMode,
  });

  // S4 — drafts session is owned by PrDetailPage and threaded through the
  // PrDetail context (single source of truth for tab strip count, sticky-top
  // UnresolvedPanel, and per-tab consumers). Files tab pulls it through
  // `usePrDetailContext` rather than re-instantiating its own hook.

  // #327 slice 2 — the inline-composer lifecycle (active anchor/draft-id
  // state, flush ref, existing-draft lookup, open/click/close handlers) lives
  // in useInlineComposer.ts. handleLineClick has a stable identity there
  // (latest-ref pattern) so it can cross the memoized DiffPane boundary.
  const {
    activeAnchor,
    composerDraftId,
    setComposerDraftId,
    flushRef: activeComposerFlushRef,
    findExistingDraft,
    handleLineClick,
    handleComposerClose,
  } = useInlineComposer({ draftSession, anchorSha });

  // #302 Task 11b / #603 item C — optimistic placeholders for just-posted
  // comments (state, prune effect, refetch generation, thread grouping and the
  // per-line filter live in the hook; see useOptimisticComments.ts).
  const {
    optimisticByThread,
    newInlineLocations,
    placeholdersForLine,
    notePosted,
    noteReplyPosted,
  } = useOptimisticComments(prDetail.reviewComments);

  // #302 — the open inline composer's "another draft is staged" gate, shared
  // by the activeComposerKey stamp below and renderComposerForLine (single
  // source, so the stamp and the rendered prop can never disagree). It also
  // folds in postingInProgress (computeAnyOtherDraftsStaged returns false
  // mid-post), so a posting flip that changes the composer-visible value
  // changes the stamp too — no separate stamp slot needed.
  const anyOtherDraftsStaged = useMemo(
    () =>
      computeAnyOtherDraftsStaged(
        draftSession.session?.draftComments ?? [],
        draftSession.session?.draftReplies ?? [],
        composerDraftId,
        draftSession.postingInProgress,
      ),
    [
      draftSession.session?.draftComments,
      draftSession.session?.draftReplies,
      composerDraftId,
      draftSession.postingInProgress,
    ],
  );

  // #327 Task 12 — composite key of every location where renderComposerForLine
  // returns content: the open composer's line plus each UN-deduped new-inline
  // placeholder's line, as sorted `${filePath}:${lineNumber}=${stamp}` entries
  // joined with NUL ('\0' — the one character git forbids in paths; '|' is
  // legal and used to shatter the parse), or null when none. The `stamp` names
  // WHAT renders there — `c:${composerDraftId}:${anyOtherDraftsStaged}` for
  // the open composer plus each placeholder's clientId — because
  // renderComposerForLine below is identity-stable, so this key is the ONLY
  // channel that breaks the memoized diff bodies when composer content appears,
  // moves, disappears, is replaced in place (post-now closes the composer
  // and drops an optimistic placeholder at the SAME line — a location-only key
  // would compare equal and strand the stale composer; caught by
  // FilesTabComposer.test.tsx once Task 13 stabilized replyContext, which had
  // masked it by churning the rows on every refetch), OR changes the reactive
  // content the MOUNTED composer reads: the autosave-assigned draftId (else
  // Discard/Escape keeps the null branch — silent close, no delete — and
  // registerOpenComposer never registers the real id) and the post-now gate
  // input anyOtherDraftsStaged (#302 D3 — the gate must update live while the
  // composer is open). Those two are exactly the composerRenderDepsRef fields
  // that can change while the composer is mounted without some OTHER re-render
  // channel already firing: prRef/prState/readOnly changes re-render every row
  // via the replyContext prop's identity, initialBody/findExistingDraft matter
  // only at mount, and the remaining fields are identity-stable callbacks.
  // CRITICAL: the format must stay identical to UnifiedDiffBody's parse — it
  // splits the key once per body render into a path-filtered
  // Map<lineNumber, stamp> — a mismatch silently defeats the mechanism
  // (guarded by FilesTab.renderCount.perf.test.tsx's inverse assertions).
  // Stamps never contain '=' or NUL (draft ids / clientIds are UUIDs or
  // counter strings) and locations split their line number at the LAST ':',
  // so exotic file paths (containing '=', ':' or '|') parse correctly.
  const activeComposerKey = useMemo(() => {
    const stamps = new Map<string, string>();
    if (activeAnchor) {
      stamps.set(
        `${activeAnchor.filePath}:${activeAnchor.lineNumber}`,
        `c:${composerDraftId ?? ''}:${anyOtherDraftsStaged ? 1 : 0}`,
      );
    }
    // Placeholder locations arrive pre-parsed from useOptimisticComments
    // (newInlineLocations) — the anchorKey string format stays private there.
    // clientIds are sorted per location so the stamp is order-stable: two
    // placeholders on one line must not churn the key when only their
    // insertion order differs (the stamp is compared by equality only).
    const clientIdsByLoc = new Map<string, string[]>();
    for (const o of newInlineLocations) {
      const loc = `${o.filePath}:${o.lineNumber}`;
      const ids = clientIdsByLoc.get(loc);
      if (ids) ids.push(o.clientId);
      else clientIdsByLoc.set(loc, [o.clientId]);
    }
    for (const [loc, ids] of clientIdsByLoc) {
      const suffix = ids.sort().join('+');
      const prev = stamps.get(loc);
      stamps.set(loc, prev ? `${prev}+${suffix}` : suffix);
    }
    if (stamps.size === 0) return null;
    return [...stamps.entries()]
      .map(([loc, stamp]) => `${loc}=${stamp}`)
      .sort()
      .join('\0'); // NUL entry joiner — the one character git forbids in paths
  }, [activeAnchor, newInlineLocations, composerDraftId, anyOtherDraftsStaged]);

  // #299 — refresh the shared draft session after each successful auto-save so
  // the Drafts tab reflects the just-saved draft live, without waiting for the
  // composer to close. The diff-and-prefer merge in useDraftSession preserves
  // this still-open composer's local body across the refetch. GET /draft is a
  // local backend read (no GitHub call), so the per-save cost is a cheap
  // loopback alongside the write that already happened.
  const handleComposerSaved = useCallback(() => {
    void draftSession.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the stable draftSession.refetch useCallback, not the per-render draftSession object literal (#331)
  }, [draftSession.refetch]);

  const prState: 'open' | 'closed' | 'merged' = prDetail.pr.isMerged
    ? 'merged'
    : prDetail.pr.isClosed
      ? 'closed'
      : 'open';

  // #327 Task 12 — renderComposerForLine crosses the memoized diff-body
  // boundary, so it is created ONCE (useCallback, no deps) and reads every
  // input through a ref updated each render (latest-ref pattern — the same
  // idiom as useInlineComposer's handleLineClick and DiffPane's n/p navRef).
  // Its rendered output for any (filePath, lineNumber) is unchanged; only the
  // function identity is stabilized. The memoized bodies re-render on composer
  // location changes via activeComposerKey (above), never via this function's
  // identity.
  const composerRenderDepsRef = useLatestRef({
    activeAnchor,
    placeholdersForLine,
    findExistingDraft,
    prState,
    composerDraftId,
    setComposerDraftId,
    draftSession,
    handleComposerClose,
    handleComposerSaved,
    readOnly,
    notePosted,
    prRef,
    anyOtherDraftsStaged,
  });

  const renderComposerForLine = useCallback(
    (filePath: string, lineNumber: number): React.ReactNode => {
      const {
        activeAnchor,
        placeholdersForLine,
        findExistingDraft,
        prState,
        composerDraftId,
        setComposerDraftId,
        draftSession,
        handleComposerClose,
        handleComposerSaved,
        readOnly,
        notePosted,
        prRef,
        anyOtherDraftsStaged,
      } = composerRenderDepsRef.current;

      const composerHere =
        activeAnchor !== null &&
        activeAnchor.filePath === filePath &&
        activeAnchor.lineNumber === lineNumber;

      // #302 Task 11b — new-inline optimistic placeholders for this line
      // (anchor-key match + databaseId de-dup live in useOptimisticComments).
      const placeholdersHere = placeholdersForLine(filePath, lineNumber);

      if (!composerHere && placeholdersHere.length === 0) return null;

      const placeholderCards = placeholdersHere.map((o) => (
        <CommentCard
          key={o.clientId}
          author={o.author}
          createdAt={o.createdAt}
          body={o.body}
          density="compact"
          className="comment-card--posting"
          data-testid="inline-comment-card-optimistic"
        />
      ));

      if (!composerHere) {
        return <>{placeholderCards}</>;
      }

      // composerHere guarantees activeAnchor is non-null; capture it so the
      // closures below (and TS) see a non-nullable anchor.
      const anchor = activeAnchor!;
      const existing = findExistingDraft(anchor);
      return (
        <>
          {placeholderCards}
          <InlineCommentComposer
            prRef={prRef}
            prState={prState}
            anchor={anchor}
            initialBody={existing?.bodyMarkdown ?? ''}
            draftId={composerDraftId}
            onDraftIdChange={setComposerDraftId}
            registerOpenComposer={draftSession.registerOpenComposer}
            onCreated={draftSession.insertDraftLocally}
            onClose={handleComposerClose}
            onSaved={handleComposerSaved}
            flushRef={activeComposerFlushRef}
            readOnly={readOnly}
            // The shared memo above — also folded into the composer's
            // activeComposerKey stamp, so a change here re-renders the hosting
            // row and this ref-read is never stale (#302 D3).
            anyOtherDraftsStaged={anyOtherDraftsStaged}
            beginPosting={draftSession.beginPosting}
            endPosting={draftSession.endPosting}
            onPosted={(postedCommentId, body) => {
              // New inline thread — no server thread id yet. The hook anchors the
              // placeholder to this line so renderComposerForLine can place it
              // after the composer closes.
              notePosted(anchor, postedCommentId, body);
              void draftSession.refetch();
            }}
          />
        </>
      );
    },
    // Ref-only deps: activeComposerFlushRef (a useRef from useInlineComposer)
    // and composerRenderDepsRef (useLatestRef) are stable ref objects, so the
    // callback identity never changes.
    [activeComposerFlushRef, composerRenderDepsRef],
  );

  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const collapse = useMemo<ThreadCollapseControl>(
    () => ({
      isCollapsed: (threadId, isResolved) =>
        effectiveCollapsed(collapseOverrides, threadId, isResolved),
      toggle: (threadId, isResolved) =>
        setCollapseOverrides((m) => nextOverrides(m, threadId, isResolved)),
      clearCollapseOverride: (threadId) => setCollapseOverrides((m) => clearOverride(m, threadId)),
    }),
    [collapseOverrides],
  );

  // #571 — a resolve/unresolve on any thread (in this tab or another) reloads
  // PR detail so ThreadView's isResolved reflects the server's state.
  useReviewThreadResolutionChangedSubscriber({ prRef, onChanged: reload });

  // #327 Task 13 — the reply wiring is SPLIT (Task 40 Step 3 grew both halves
  // into one churning bag):
  //
  //   (A) `replyContext` — the STABLE callbacks bag (+ the rarely-changing
  //       prRef/prState/readOnly scalars). Every callback is created once and
  //       reads its live inputs through a ref updated each render (latest-ref
  //       pattern — the same idiom as renderComposerForLine above), so the bag
  //       can cross the memoized diff rows (DiffLineRow / the body memos)
  //       without breaking their bail on any autosave refetch. Stability also
  //       keeps `ReplyComposer`'s `registerOpenComposer` useEffect from
  //       tearing down and re-registering the refcount entry every render,
  //       which would briefly drop the diff-and-prefer merge protection for
  //       the open draft.
  //   (B) `replyData` (below) — the REACTIVE per-thread data channel.
  const replyCallbackDepsRef = useLatestRef({
    registerOpenComposer: draftSession.registerOpenComposer,
    refetch: draftSession.refetch,
    insertDraftLocally: draftSession.insertDraftLocally,
    beginPosting: draftSession.beginPosting,
    endPosting: draftSession.endPosting,
    noteReplyPosted,
  });

  const replyContext = useMemo<ExistingCommentWidgetReplyContext>(
    () => ({
      prRef,
      prState,
      readOnly,
      registerOpenComposer: (draftId, ownerKey) =>
        replyCallbackDepsRef.current.registerOpenComposer(draftId, ownerKey),
      // Refetch after the reply composer closes (mirrors the on-close path the
      // inline composer uses for the own-tab refresh-after-write case).
      onReplyComposerClose: () => {
        void replyCallbackDepsRef.current.refetch();
      },
      // #302 — post-now wiring (Task 11a). The reply's own draft id is known
      // inside ExistingCommentWidget when it mounts the ReplyComposer, so the
      // anyOtherDraftsStaged check is computed there from the replyData channel
      // (computeAnyOtherDraftsStaged) rather than threaded as a closure here.
      beginPosting: () => replyCallbackDepsRef.current.beginPosting(),
      endPosting: () => replyCallbackDepsRef.current.endPosting(),
      // #744 — optimistic insert on reply create (mirrors the inline/pr-root
      // surfaces). Stable useCallback under the hood; routed through the ref to
      // keep this memo's identity stable.
      insertDraftLocally: (draft) => replyCallbackDepsRef.current.insertDraftLocally(draft),
      // #302 Task 11b — stash an optimistic placeholder for the thread, then
      // refetch. The placeholder is de-duped against the refetched comment by
      // databaseId (postedCommentId), in the hook and at render in
      // ExistingCommentWidget.
      onReplyPosted: (threadId, postedCommentId, body) => {
        replyCallbackDepsRef.current.noteReplyPosted(threadId, postedCommentId, body);
        void replyCallbackDepsRef.current.refetch();
      },
      // #571 — reload is a stable function from usePrDetailContext, so adding
      // it here does not churn this memo (it's listed as a dep, not routed
      // through replyCallbackDepsRef, since it never changes identity).
      reload,
    }),
    // replyCallbackDepsRef is a stable useLatestRef object — listed only to
    // satisfy the lint rule; it never invalidates the memo. reload is a
    // stable function from context — same reasoning.
    [prRef, prState, readOnly, replyCallbackDepsRef, reload],
  );

  // #327 Task 13 — (B) the reactive per-thread data channel. `useDraftSession`'s
  // merge rebuilds the draft arrays on every refetch, so this value's identity
  // changes on each autosave — which is exactly why it flows through
  // ReplyDataContext (consumed inside ExistingCommentWidget's ThreadView,
  // below the row memos) instead of riding the rows' props: only thread
  // widgets re-render, and a cross-tab draft-reply arrival still hydrates the
  // affected thread (a ref read would go stale there). Guarded by
  // FilesTab.renderCount.perf.test.tsx assertions (a) and (c2).
  const replyData = useMemo<ReplyData>(
    () => ({
      draftComments: draftSession.session?.draftComments ?? [],
      draftReplies: draftSession.session?.draftReplies ?? [],
      postingInProgress: draftSession.postingInProgress,
      optimisticByThread,
    }),
    [
      draftSession.session?.draftComments,
      draftSession.session?.draftReplies,
      draftSession.postingInProgress,
      optimisticByThread,
    ],
  );

  return (
    <div className={`files-tab ${styles.filesTab}`} data-testid="files-tab-root">
      {/* Polite live region for the deep-link announcement (spec §8). Visually
          hidden; effect (2) sets it once when a pending path is applied so the
          screen reader announces the destination. */}
      <div aria-live="polite" className="sr-only" data-testid="files-tab-live-region">
        {liveMessage}
      </div>
      <div className={`files-tab-toolbar ${styles.filesTabToolbar}`}>
        {isLowQuality ? (
          <CommitMultiSelectPicker
            commits={prDetail.commits}
            selectedShas={selectedCommits}
            onSelectionChange={handleCommitsChange}
          />
        ) : prDetail.iterations && prDetail.iterations.length > 0 ? (
          <IterationTabStrip
            iterations={prDetail.iterations}
            activeRange={activeRange}
            onRangeChange={handleRangeChange}
          />
        ) : null}
        <DiffViewToggle
          diffMode={effectiveDiffMode}
          onDiffModeChange={setDiffMode}
          splitDisabled={!isSplitCapable}
          splitDisabledReason="Side-by-side needs a wider window."
        />
        <DiffSettingsMenu
          showFullFile={showFullFile}
          onShowFullFileChange={setShowFullFile}
          fullFileViewBlocked={fullFileViewBlocked}
          fullFileViewBlockedReason={fullFileViewBlockedReason}
          fullFileInertHere={fullFileInertHere}
          fullFileInertReason={fullFileInertReason}
          lineWrap={lineWrap}
          onLineWrapChange={setLineWrap}
        />
      </div>

      {diff.error &&
        (isRangeUnreachable(diff.error) ? (
          <div
            role="alert"
            className={`files-tab-error ${styles.filesTabError}`}
            data-testid="diff-unavailable"
          >
            This diff is unavailable — the commit range is no longer reachable on GitHub (the branch
            or commits may have been deleted).
          </div>
        ) : (
          <div role="alert" className={`files-tab-error ${styles.filesTabError}`}>
            Failed to load diff — {diff.error.message}
          </div>
        ))}

      <div className={`files-tab-content ${styles.filesTabContent}`}>
        <div className={`files-tab-tree ${styles.filesTabTree}`} data-testid="files-tab-tree">
          {/* This tree skeleton is gated on the RANGE-keyed diff query
              (useFileDiff: [owner,repo,number,range]), not the reload counter —
              so it does NOT flip on PR-detail re-activation (#180) and is
              intentionally not subject to that fix's `!data` gate. It shows only
              on a genuine iteration/commit-range change, where the file row set
              really is unknown and a skeleton is correct. */}
          {diff.showSkeleton ? (
            <div
              className={`file-tree-skeleton ${styles.fileTreeSkeleton}`}
              aria-label="Loading files"
              aria-busy="true"
            >
              <div className={`skeleton-row ${styles.skeletonRow}`} />
              <div className={`skeleton-row ${styles.skeletonRow}`} />
              <div className={`skeleton-row ${styles.skeletonRow}`} />
            </div>
          ) : (
            <FileTree
              files={files}
              tree={tree}
              selectedPath={selectedPath}
              onSelectFile={setSelectedPath}
              viewedPaths={viewedPaths}
              onToggleViewed={toggleViewed}
              isLoading={diff.isLoading}
              focusEntries={focusEntries}
              focusStatus={fileFocus.status}
              annotationsLoading={aiHunkAnnotations.state === 'loading'}
              aiPreview={aiDotsOn}
              commentStateByPath={commentStateByPath}
              commentCountsByPath={commentCountsByPath}
            />
          )}
        </div>
        <div
          ref={diffRegionRef}
          tabIndex={-1}
          className={`files-tab-diff ${styles.filesTabDiff}`}
          data-testid="files-tab-diff"
        >
          <ReplyDataProvider value={replyData}>
            <DiffPane
              prRef={prRef}
              selectedPath={selectedPath}
              file={selectedFile}
              diffMode={effectiveDiffMode}
              truncated={diff.data?.truncated ?? false}
              reviewThreads={fileThreads}
              htmlUrl={htmlUrl}
              onLineClick={handleLineClick}
              renderComposerForLine={renderComposerForLine}
              activeComposerKey={activeComposerKey}
              replyContext={replyContext}
              collapse={collapse}
              isLoading={diff.isLoading}
              wholeFileEnabled={wholeFileEnabled}
              onWholeFileFailed={handleWholeFileFailed}
              onWholeFileRetry={handleWholeFileRetry}
              headSha={prDetail.pr.headSha}
              baseSha={prDetail.pr.baseSha}
              lineWrap={lineWrap}
              annotations={aiHunkAnnotations.annotations}
            />
          </ReplyDataProvider>
        </div>
      </div>
    </div>
  );
}
