import { useState, useCallback, useMemo, useEffect } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import type { PrReference } from '../../../api/types';
import { ApiError } from '../../../api/client';
import { postFileViewed } from '../../../api/fileViewed';
import { sendPatch } from '../../../api/draft';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useUnionDiff } from '../../../hooks/useUnionDiff';
import { useFilesTabShortcuts } from '../../../hooks/useFilesTabShortcuts';
import { useAiGate } from '../../../hooks/useAiGate';
import { useAiFileFocus } from '../../../hooks/useAiFileFocus';
import { FileTree } from './FileTree';
import { DiffPane } from './DiffPane';
import type { DiffMode } from './DiffPane';
import { IterationTabStrip } from './IterationTabStrip';
import { CommitMultiSelectPicker } from './CommitMultiSelectPicker';
import { buildAllRange } from '../range';
import { buildTree, flattenPaths } from './treeBuilder';
import { InlineCommentComposer } from '../Composer/InlineCommentComposer';
import type { InlineAnchor } from '../Composer/InlineCommentComposer';
import { Modal } from '../../Modal/Modal';
import type { PrDetailOutletContext } from '../../../pages/PrDetailPage';
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
  const { prDetail, draftSession, readOnly } = useOutletContext<PrDetailOutletContext>();
  const {
    owner,
    repo,
    number: numberStr,
  } = useParams<{
    owner: string;
    repo: string;
    number: string;
  }>();

  const prRef: PrReference = useMemo(
    () => ({ owner: owner!, repo: repo!, number: Number(numberStr) }),
    [owner, repo, numberStr],
  );

  const isLowQuality = prDetail.clusteringQuality === 'low';

  const fileFocusEnabled = useAiGate('fileFocus');
  const focusEntries = useAiFileFocus(prRef, fileFocusEnabled);

  const [activeRange, setActiveRange] = useState<string>('all');
  const [selectedCommits, setSelectedCommits] = useState<string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('side-by-side');
  const [wholeFilePaths, setWholeFilePaths] = useState<Set<string>>(new Set());
  // #115 — line-wrap is a view-wide preference (like diffMode, not per-file):
  // false = a single synthetic scrollbar shifts both split panes in lockstep
  // (useLockedPaneScroll); true = long lines soft-wrap within their pane.
  const [lineWrap, setLineWrap] = useState(false);

  const iterationGatePermits = activeRange === 'all' && selectedCommits === null;
  // wholeFileEnabled is fully derived below, after `selectedFile` is computed,
  // so it can include the file.status + file.hunks.length gates that the
  // toolbar button's disabled-condition uses. This keeps the button's pressed
  // state and the prop passed to DiffPane consistent — without those extra
  // gates, a path persisted in wholeFilePaths across a status/hunks change
  // would leave the button showing "Hunks only" / aria-pressed=true while the
  // hook self-disables via its inactive gate (Copilot iter-3 findings F-B + F-C).

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

  const wholeFileEnabled =
    selectedPath !== null &&
    wholeFilePaths.has(selectedPath) &&
    iterationGatePermits &&
    selectedFile !== null &&
    selectedFile.status === 'modified' &&
    selectedFile.hunks.length > 0;

  const fileThreads = useMemo(
    () => (selectedPath ? prDetail.reviewComments.filter((t) => t.filePath === selectedPath) : []),
    [prDetail.reviewComments, selectedPath],
  );

  const prUrl = `https://github.com/${owner}/${repo}/pull/${numberStr}`;

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

  const handleToggleLineWrap = useCallback(() => {
    setLineWrap((prev) => !prev);
  }, []);

  const handleToggleWholeFile = useCallback(() => {
    if (!selectedPath) return;
    setWholeFilePaths((prev) => {
      const next = new Set(prev);
      if (next.has(selectedPath)) next.delete(selectedPath);
      else next.add(selectedPath);
      return next;
    });
  }, [selectedPath]);

  const handleWholeFileFailed = useCallback(
    // Reason is part of the callback contract but not used here — FilesTab
    // only needs to know SOMETHING failed, not what. DiffPane's local latch
    // holds the reason string and renders the banner from it.
    (reason: string) => {
      void reason; // reserved — see above
      if (!selectedPath) return;
      setWholeFilePaths((prev) => {
        if (!prev.has(selectedPath)) return prev;
        const next = new Set(prev);
        next.delete(selectedPath);
        return next;
      });
    },
    [selectedPath],
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
  // Outlet context (single source of truth for tab strip count, sticky-top
  // UnresolvedPanel, and per-tab consumers). Files tab pulls it through
  // `useOutletContext` rather than re-instantiating its own hook.

  // Active inline composer state. activeAnchor + composerDraftId together
  // describe "the composer the user is currently in". pendingNewAnchor is
  // set when the user clicks a different line while a saved-draft composer
  // is open (A2 flow).
  const [activeAnchor, setActiveAnchor] = useState<InlineAnchor | null>(null);
  const [composerDraftId, setComposerDraftId] = useState<string | null>(null);
  const [pendingNewAnchor, setPendingNewAnchor] = useState<InlineAnchor | null>(null);

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
    // No active composer → open immediately.
    if (activeAnchor === null) {
      openComposerAt(rawAnchor);
      return;
    }
    // Active composer with no persisted draft id → close (no PUT) + open new.
    if (composerDraftId === null) {
      openComposerAt(rawAnchor);
      return;
    }
    // Active composer WITH a persisted draft id → A2 transition modal.
    setPendingNewAnchor({ ...rawAnchor, anchoredSha: prDetail.pr.headSha });
  }

  async function handleTransitionDiscard() {
    if (composerDraftId !== null) {
      let result;
      try {
        result = await sendPatch(prRef, {
          kind: 'deleteDraftComment',
          payload: { id: composerDraftId },
        });
      } catch {
        // Network / non-ApiError. Keep the transition modal open; the
        // user retries or hits Keep.
        return;
      }
      if (!result.ok) {
        // Backend rejection (404 / 422 / 409 / 5xx). Don't proceed —
        // closing the modal and opening the new composer would
        // optimistically appear that the saved draft was discarded
        // when the server still has it.
        return;
      }
      // Sync local session so the deleted draft doesn't surface as
      // existing data when the new composer's hydrate-from-session path
      // (or any later render) runs.
      await draftSession.refetch();
    }
    if (pendingNewAnchor) {
      openComposerAt(pendingNewAnchor);
    }
    setPendingNewAnchor(null);
  }

  function handleTransitionKeep() {
    // Leave the saved draft persisted; just close the composer panel and
    // open a new one at the new line. The kept draft remains in
    // session.draftComments and will reappear if the user navigates back.
    if (pendingNewAnchor) {
      openComposerAt(pendingNewAnchor);
    }
    setPendingNewAnchor(null);
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
    <div className={`files-tab ${styles.filesTab}`} data-testid="files-tab">
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
        <button
          type="button"
          className={styles.diffModeToggle}
          aria-pressed={effectiveDiffMode === 'side-by-side'}
          disabled={viewportWidth < 900}
          onClick={handleToggleDiffMode}
        >
          {effectiveDiffMode === 'side-by-side' ? 'Side-by-side' : 'Unified'}
        </button>
        <button
          type="button"
          className={styles.wholeFileToggle}
          aria-pressed={wholeFileEnabled}
          disabled={
            selectedPath === null ||
            !selectedFile ||
            selectedFile.status !== 'modified' ||
            selectedFile.hunks.length === 0 ||
            !iterationGatePermits
          }
          title={
            !iterationGatePermits
              ? "Whole-file view available only on the 'all' iteration view"
              : selectedFile && selectedFile.status !== 'modified'
                ? 'Whole-file view available for modified files only'
                : selectedFile && selectedFile.hunks.length === 0
                  ? 'Whole-file view not available — no diff hunks to expand'
                  : ''
          }
          onClick={handleToggleWholeFile}
          data-testid="whole-file-toggle"
        >
          {wholeFileEnabled ? 'Hunks only' : 'Show full file'}
        </button>
        <button
          type="button"
          className={styles.lineWrapToggle}
          aria-pressed={lineWrap}
          onClick={handleToggleLineWrap}
          data-testid="line-wrap-toggle"
          title={lineWrap ? 'Switch to scrolling long lines' : 'Switch to wrapping long lines'}
        >
          {/* Stable label + aria-pressed carries on/off — a label that flipped
              with state would contradict aria-pressed for assistive tech
              (Copilot PR #149 review). */}
          Wrap long lines
        </button>
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

      <Modal
        open={pendingNewAnchor !== null}
        title="Discard or keep your saved draft?"
        defaultFocus="cancel"
        onClose={() => setPendingNewAnchor(null)}
      >
        <p>You have a saved draft on the line you&apos;re leaving. Switch to the new line and:</p>
        <button type="button" data-modal-role="cancel" onClick={handleTransitionKeep}>
          Keep
        </button>
        <button type="button" data-modal-role="primary" onClick={handleTransitionDiscard}>
          Discard
        </button>
      </Modal>
    </div>
  );
}
