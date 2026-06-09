import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ApiError } from '../../../api/client';
import { postFileViewed } from '../../../api/fileViewed';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useUnionDiff } from '../../../hooks/useUnionDiff';
import { useFilesTabShortcuts } from '../../../hooks/useFilesTabShortcuts';
import { useAiGate } from '../../../hooks/useAiGate';
import { useAiFileFocus } from '../../../hooks/useAiFileFocus';
import { FileTree } from './FileTree';
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
import styles from './FilesTab.module.css';

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

function useViewportWidth() {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return width;
}

export function FilesTab() {
  const { prRef, prDetail, draftSession, readOnly } = usePrDetailContext();

  const isLowQuality = prDetail.clusteringQuality === 'low';

  const fileFocusEnabled = useAiGate('fileFocus');
  const focusEntries = useAiFileFocus(prRef, fileFocusEnabled);

  const [activeRange, setActiveRange] = useState<string>('all');
  const [selectedCommits, setSelectedCommits] = useState<string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('side-by-side');
  // #115 — line-wrap is a view-wide preference (like diffMode, not per-file):
  // false = a single synthetic scrollbar shifts both split panes in lockstep
  // (useLockedPaneScroll); true = long lines soft-wrap within their pane.
  const [lineWrap, setLineWrap] = useState(false);
  const { showFullFile, setShowFullFile, failedPaths, markFailed } = useWholeFilePreference();

  const iterationGatePermits = activeRange === 'all' && selectedCommits === null;
  // wholeFileEnabled is fully derived below, after `selectedFile` is computed,
  // so it can include the file.status + file.hunks.length gates. This keeps the
  // effective flag passed to DiffPane consistent with the gear menu's helper text.

  const viewportWidth = useViewportWidth();
  const effectiveDiffMode: DiffMode = viewportWidth < 900 ? 'unified' : diffMode;

  const handleRangeChange = useCallback((range: string) => {
    setActiveRange(range);
    setSelectedPath(null);
  }, []);

  const handleCommitsChange = useCallback((shas: string[] | null) => {
    setSelectedCommits(shas);
    setSelectedPath(null);
  }, []);
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(new Set());

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

  // Auto-select the first file in tree order when none is selected, OR when
  // the previously-selected path is no longer in the diff's file list (e.g.
  // a pr-updated SSE shifted the diff and the user's selected file is gone).
  // Mirrors GitHub / ADO / GitLab: landing on /files opens the first changed
  // file rather than showing the empty-pane prompt. Re-fires after iteration
  // or commit-multi-select changes (both reset selectedPath to null), and on
  // orphaned-selection refreshes (preflight finding).
  useEffect(() => {
    if (fileList.length === 0) return;
    if (selectedPath === null || !fileList.includes(selectedPath)) {
      setSelectedPath(fileList[0]);
    }
  }, [fileList, selectedPath]);

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

  const prUrl = prDetail.pr.htmlUrl ?? undefined;

  const handleToggleViewed = useCallback(
    (path: string) => {
      let wasViewed = false;
      setViewedPaths((prev) => {
        wasViewed = prev.has(path);
        const next = new Set(prev);
        if (wasViewed) next.delete(path);
        else next.add(path);
        return next;
      });

      postFileViewed(prRef, {
        path,
        headSha: prDetail.pr.headSha,
        viewed: !wasViewed,
      }).catch(() => {
        setViewedPaths((prev) => {
          const next = new Set(prev);
          if (wasViewed) next.add(path);
          else next.delete(path);
          return next;
        });
      });
    },
    [prRef, prDetail.pr.headSha],
  );

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
    if (viewportWidth < 900) return;
    setDiffMode((prev) => (prev === 'side-by-side' ? 'unified' : 'side-by-side'));
  }, [viewportWidth]);

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

  useFilesTabShortcuts({
    onNextFile: handleNextFile,
    onPrevFile: handlePrevFile,
    onToggleViewed: () => {
      if (selectedPath) handleToggleViewed(selectedPath);
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
  }, [draftSession.refetch]);

  const prState: 'open' | 'closed' | 'merged' = prDetail.pr.isMerged
    ? 'merged'
    : prDetail.pr.isClosed
      ? 'closed'
      : 'open';

  function renderComposerForLine(filePath: string, lineNumber: number): React.ReactNode {
    if (!activeAnchor) return null;
    if (activeAnchor.filePath !== filePath) return null;
    if (activeAnchor.lineNumber !== lineNumber) return null;
    const existing = findExistingDraft(activeAnchor);
    return (
      <InlineCommentComposer
        prRef={prRef}
        prState={prState}
        anchor={activeAnchor}
        initialBody={existing?.bodyMarkdown ?? ''}
        draftId={composerDraftId}
        onDraftIdChange={setComposerDraftId}
        registerOpenComposer={draftSession.registerOpenComposer}
        onClose={handleComposerClose}
        onSaved={handleComposerSaved}
        flushRef={activeComposerFlushRef}
        readOnly={readOnly}
      />
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
  }, [draftSession.refetch]);

  const replyContext = useMemo(
    () => ({
      prRef,
      prState,
      draftReplies: draftSession.session?.draftReplies ?? [],
      registerOpenComposer: draftSession.registerOpenComposer,
      onReplyComposerClose: handleReplyComposerClose,
      readOnly,
    }),
    [
      prRef,
      prState,
      draftSession.session?.draftReplies,
      draftSession.registerOpenComposer,
      handleReplyComposerClose,
      readOnly,
    ],
  );

  return (
    <div className={`files-tab ${styles.filesTab}`} data-testid="files-tab-root">
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
          splitDisabled={viewportWidth < 900}
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
              onToggleViewed={handleToggleViewed}
              isLoading={diff.isLoading}
              focusEntries={focusEntries}
              aiPreview={fileFocusEnabled}
            />
          )}
        </div>
        <div className={`files-tab-diff ${styles.filesTabDiff}`} data-testid="files-tab-diff">
          <DiffPane
            prRef={prRef}
            selectedPath={selectedPath}
            file={selectedFile}
            diffMode={effectiveDiffMode}
            truncated={diff.data?.truncated ?? false}
            reviewThreads={fileThreads}
            prUrl={prUrl}
            onLineClick={handleLineClick}
            renderComposerForLine={renderComposerForLine}
            replyContext={replyContext}
            isLoading={diff.isLoading}
            wholeFileEnabled={wholeFileEnabled}
            onWholeFileFailed={handleWholeFileFailed}
            headSha={prDetail.pr.headSha}
            baseSha={prDetail.pr.baseSha}
            lineWrap={lineWrap}
          />
        </div>
      </div>
    </div>
  );
}
