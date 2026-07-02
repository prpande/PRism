import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ApiError } from '../../../api/client';
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
import { buildAllRange } from '../range';
import { buildTree, flattenPaths } from './treeBuilder';
import { InlineCommentComposer } from '../Composer/InlineCommentComposer';
import type { InlineAnchor } from '../Composer/InlineCommentComposer';
import { usePrDetailContext } from '../prDetailContext';
import { useIsSplitCapable } from './useIsSplitCapable';
import { computeAnyOtherDraftsStaged } from '../../../hooks/useDraftSession';
import {
  pruneOptimistic,
  OPTIMISTIC_FALLBACK_MAX_AGE_MS,
  type OptimisticComment,
} from './optimisticComment';
import { CommentCard } from '../Comment/CommentCard';
import styles from './FilesTab.module.css';
import type { ThreadCollapseControl } from './DiffPane/ExistingCommentWidget';

// #302 — no viewer login on PrDetailDto; optimistic placeholders are by
// construction the current user's.
const VIEWER_LABEL = 'You';

// Unique React key per optimistic placeholder. crypto.randomUUID where
// available (jsdom + modern browsers), else a small monotonic fallback so the
// function is total in bare-node test contexts.
// NOTE: optimisticCounter is a module-scoped fallback only used when
// crypto.randomUUID is unavailable; a process-global monotonic counter keeps
// ids unique even across multiple kept-alive FilesTab instances.
let optimisticCounter = 0;
function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  optimisticCounter += 1;
  return `optimistic-${optimisticCounter}`;
}

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

  // Hoisted: single flat list of all real comments — used both by the optimistic
  // cleanup effect and by renderComposerForLine's placeholder filter (avoids an
  // O(lines×comments) flatMap per render call).
  const allRealComments = useMemo(
    () => prDetail.reviewComments.flatMap((t) => t.comments),
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

  // Active inline composer state. activeAnchor + composerDraftId together
  // describe "the composer the user is currently in".
  const [activeAnchor, setActiveAnchor] = useState<InlineAnchor | null>(null);
  const [composerDraftId, setComposerDraftId] = useState<string | null>(null);
  // #299 — holds the active composer's flush so a line switch can persist a
  // pending debounced edit before the composer is swapped out (the modal that
  // used to bridge that gap is gone). The composer (un)registers it itself.
  const activeComposerFlushRef = useRef<(() => Promise<string | null>) | null>(null);

  // #302 Task 11b — optimistic placeholders for just-posted comments. A post-now
  // pushes an entry here so the comment appears instantly (dimmed) instead of
  // after the ~300-800ms refetch round-trip. Each entry is dropped once the
  // refetched reviewComments contain a real comment whose `databaseId` equals
  // the entry's `postedCommentId` (de-dup keyed on databaseId — body text is
  // NEVER the key; see optimisticComment.ts).
  const [optimistic, setOptimistic] = useState<OptimisticComment[]>([]);

  // #603 item C — refetch generation. allRealComments is a fresh array on every
  // reviewComments refetch, so bumping a counter here lets the cleanup below tell
  // whether a refetch has landed *since* a given placeholder was created (the
  // precondition for the bounded fallback eviction).
  const refetchGenRef = useRef(0);

  // Cleanup effect: when a refetch lands, drop optimistic placeholders. Fast
  // path is the databaseId === postedCommentId match (ExistingCommentWidget
  // repeats it at render time as belt-and-suspenders). Fallback (#603 item C):
  // a posted comment can surface with databaseId === null (real GitHub
  // responses do), which the fast-path can never match — so once a refetch has
  // landed after the placeholder was created AND it has aged past the bound,
  // evict it anyway, preventing a permanent visible duplicate. A one-shot timer
  // re-runs the prune at the age bound so a databaseId-less placeholder still
  // evicts even without a further refetch.
  useEffect(() => {
    refetchGenRef.current += 1;
    const gen = refetchGenRef.current;
    setOptimistic((prev) => pruneOptimistic(prev, allRealComments, gen, Date.now()));
    const timer = setTimeout(() => {
      setOptimistic((prev) =>
        pruneOptimistic(prev, allRealComments, refetchGenRef.current, Date.now()),
      );
    }, OPTIMISTIC_FALLBACK_MAX_AGE_MS);
    return () => clearTimeout(timer);
  }, [allRealComments]);

  // Group reply/existing-thread optimistic entries by threadId for the reply
  // context. New-inline entries (threadId === null) are rendered separately at
  // their anchor line via renderComposerForLine.
  const optimisticByThread = useMemo(() => {
    const map: Record<string, OptimisticComment[]> = {};
    for (const o of optimistic) {
      if (o.threadId == null) continue;
      (map[o.threadId] ??= []).push(o);
    }
    return map;
  }, [optimistic]);

  function findExistingDraft(anchor: InlineAnchor): { id: string; bodyMarkdown: string } | null {
    const session = draftSession.session;
    if (!session) return null;
    const match = session.draftComments.find(
      (d) =>
        d.filePath === anchor.filePath &&
        d.lineNumber === anchor.lineNumber &&
        d.side === anchor.side,
    );
    return match ? { id: match.id, bodyMarkdown: match.bodyMarkdown } : null;
  }

  function openComposerAt(rawAnchor: InlineAnchor) {
    // DiffPane sends back an empty anchoredSha. PoC simplification: stamp
    // prDetail.pr.headSha for every right-side click. This is correct for
    // the "All changes" iteration range (afterSha === headSha) but wrong
    // for older iteration views — the iteration's afterSha would be the
    // right anchor. Deferred (see deferrals doc); DiffPane only allows
    // right-side clicks so the SHA is always a valid HEAD anchor.
    const anchor: InlineAnchor = { ...rawAnchor, anchoredSha: prDetail.pr.headSha };
    const existing = findExistingDraft(anchor);
    setActiveAnchor(anchor);
    setComposerDraftId(existing?.id ?? null);
  }

  function handleLineClick(rawAnchor: InlineAnchor) {
    // Same-anchor click → no-op (composer already mounted there).
    if (
      activeAnchor &&
      activeAnchor.filePath === rawAnchor.filePath &&
      activeAnchor.lineNumber === rawAnchor.lineNumber &&
      activeAnchor.side === rawAnchor.side
    ) {
      return;
    }
    // #299 — drafts auto-save as the author types, so switching lines never
    // needs a "keep or discard?" prompt: whatever was being drafted is already
    // persisted. Flush any pending (sub-debounce) edit of the current composer
    // first so a fast line switch doesn't drop the last keystrokes, then open
    // the composer at the new line. A saved draft left behind stays persisted
    // (and reappears via findExistingDraft when the user clicks back to its
    // line); discarding it is an explicit action on the composer's Discard
    // button. The flush is fire-and-forget — it reads the latest body before
    // the composer unmounts, and onSaved refetches when it lands. We don't
    // block the switch on it, but a rejection is logged rather than swallowed:
    // the unmounted composer has no badge to surface the failure, and the
    // dropped edit is otherwise invisible (the draft's last-saved state stays
    // intact).
    activeComposerFlushRef.current?.().catch((err) => {
      console.error('[FilesTab] flush on line-switch failed; latest edit may be unsaved', err);
    });
    openComposerAt(rawAnchor);
  }

  function handleComposerClose() {
    setActiveAnchor(null);
    setComposerDraftId(null);
    // Own-tab mutations are filtered by useStateChangedSubscriber, so the
    // SSE channel won't trigger a refetch for changes this tab made.
    // Refresh on close so the next click at the same anchor sees the
    // just-saved/just-deleted state and avoids creating a duplicate draft.
    void draftSession.refetch();
  }

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

  function renderComposerForLine(filePath: string, lineNumber: number): React.ReactNode {
    const composerHere =
      activeAnchor !== null &&
      activeAnchor.filePath === filePath &&
      activeAnchor.lineNumber === lineNumber;

    // #302 Task 11b — new-inline optimistic placeholders for this line. Matched
    // by filePath:lineNumber (side-agnostic for placement; the line is the
    // anchor the user sees). De-dup by databaseId vs the now-real reviewComments
    // (so the placeholder vanishes the instant the refetch lands its comment).
    // allRealComments is a hoisted useMemo (closure capture) — no per-line flatMap.
    const placeholdersHere = optimistic.filter(
      (o) =>
        o.threadId == null &&
        o.anchorKey != null &&
        o.anchorKey.startsWith(`${filePath}:${lineNumber}:`) &&
        !allRealComments.some((c) => c.databaseId != null && c.databaseId === o.postedCommentId),
    );

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
          onClose={handleComposerClose}
          onSaved={handleComposerSaved}
          flushRef={activeComposerFlushRef}
          readOnly={readOnly}
          anyOtherDraftsStaged={computeAnyOtherDraftsStaged(
            draftSession.session?.draftComments ?? [],
            draftSession.session?.draftReplies ?? [],
            composerDraftId,
            draftSession.postingInProgress,
          )}
          beginPosting={draftSession.beginPosting}
          endPosting={draftSession.endPosting}
          onPosted={(postedCommentId, body) => {
            // New inline thread — no server thread id yet. Anchor the placeholder
            // to this line so renderComposerForLine can place it after the
            // composer closes. Keyed by filePath:lineNumber:side.
            const anchorKey = `${anchor.filePath}:${anchor.lineNumber}:${anchor.side}`;
            setOptimistic((o) => [
              ...o,
              {
                clientId: newClientId(),
                threadId: null,
                anchorKey,
                body,
                author: VIEWER_LABEL,
                createdAt: new Date().toISOString(),
                createdGen: refetchGenRef.current,
                postedCommentId,
              },
            ]);
            void draftSession.refetch();
          }}
        />
      </>
    );
  }

  // Per-thread reply composer wiring (Task 40 Step 3). Each
  // ExistingCommentWidget receives the bag and self-manages composer state
  // (one open reply per thread, multiple threads can host open replies
  // simultaneously — matches the GitHub UX precedent).
  //
  // Memoized so the bag's reference is stable across renders that don't
  // touch its inputs. `ReplyComposer`'s `registerOpenComposer` useEffect
  // re-runs whenever the registry function reference changes; without
  // memoization, every parent render would tear down and re-register the
  // refcount entry, briefly dropping the diff-and-prefer merge protection
  // for the open draft.
  const handleReplyComposerClose = useCallback(() => {
    void draftSession.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the stable draftSession.refetch useCallback, not the per-render draftSession object literal (#331)
  }, [draftSession.refetch]);

  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const collapse = useMemo<ThreadCollapseControl>(
    () => ({
      isCollapsed: (threadId, isResolved) =>
        effectiveCollapsed(collapseOverrides, threadId, isResolved),
      toggle: (threadId, isResolved) =>
        setCollapseOverrides((m) => nextOverrides(m, threadId, isResolved)),
    }),
    [collapseOverrides],
  );

  const replyContext = useMemo(
    () => ({
      prRef,
      prState,
      draftComments: draftSession.session?.draftComments ?? [],
      draftReplies: draftSession.session?.draftReplies ?? [],
      postingInProgress: draftSession.postingInProgress,
      registerOpenComposer: draftSession.registerOpenComposer,
      onReplyComposerClose: handleReplyComposerClose,
      // #302 — post-now wiring (Task 11a). The reply's own draft id is known
      // inside ExistingCommentWidget when it mounts the ReplyComposer, so the
      // anyOtherDraftsStaged check is computed there from the raw pieces above
      // (computeAnyOtherDraftsStaged) rather than threaded as a closure here.
      beginPosting: draftSession.beginPosting,
      endPosting: draftSession.endPosting,
      // #302 Task 11b — stash an optimistic placeholder for the thread, then
      // refetch. The placeholder is de-duped against the refetched comment by
      // databaseId (postedCommentId), here and at render in ExistingCommentWidget.
      onReplyPosted: (threadId: string, postedCommentId: number, body: string) => {
        setOptimistic((o) => [
          ...o,
          {
            clientId: newClientId(),
            threadId,
            body,
            author: VIEWER_LABEL,
            createdAt: new Date().toISOString(),
            createdGen: refetchGenRef.current,
            postedCommentId,
          },
        ]);
        void draftSession.refetch();
      },
      optimisticByThread,
      readOnly,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps narrow to the specific draftSession members read; the draftSession object is a fresh literal each render, so depending on it would re-create the memo every render (#331)
    [
      prRef,
      prState,
      draftSession.session?.draftComments,
      draftSession.session?.draftReplies,
      draftSession.postingInProgress,
      draftSession.registerOpenComposer,
      draftSession.beginPosting,
      draftSession.endPosting,
      draftSession.refetch,
      handleReplyComposerClose,
      optimisticByThread,
      readOnly,
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
        </div>
      </div>
    </div>
  );
}
