import { useState, useCallback, useMemo, useEffect } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import type { PrDetailDto, PrReference } from '../../../api/types';
import { postFileViewed } from '../../../api/fileViewed';
import { sendPatch } from '../../../api/draft';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useUnionDiff } from '../../../hooks/useUnionDiff';
import { useFilesTabShortcuts } from '../../../hooks/useFilesTabShortcuts';
import { useDraftSession } from '../../../hooks/useDraftSession';
import { useStateChangedSubscriber } from '../../../hooks/useStateChangedSubscriber';
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

interface FilesTabContext {
  prDetail: PrDetailDto;
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
  const { prDetail } = useOutletContext<FilesTabContext>();
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

  const [activeRange, setActiveRange] = useState<string>('all');
  const [selectedCommits, setSelectedCommits] = useState<string[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('side-by-side');

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

  const selectedFile = useMemo(
    () => (selectedPath ? (files.find((f) => f.path === selectedPath) ?? null) : null),
    [files, selectedPath],
  );

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

  useFilesTabShortcuts({
    onNextFile: handleNextFile,
    onPrevFile: handlePrevFile,
    onToggleViewed: () => {
      if (selectedPath) handleToggleViewed(selectedPath);
    },
    onToggleDiffMode: handleToggleDiffMode,
  });

  // S4 — drafts session for the active PR. Powers the InlineCommentComposer
  // (initial body / draftId hydration) plus the A2 transition modal flow.
  const draftSession = useDraftSession(prRef);

  // The state-changed subscriber refetches drafts when other tabs (or the
  // reload pipeline) mutate them. Own-tab events are filtered out by the
  // subscriber (spec § 5.7).
  useStateChangedSubscriber({
    prRef,
    onSessionChange: draftSession.refetch,
  });

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
      />
    );
  }

  // Per-thread reply composer wiring (Task 40 Step 3). Each
  // ExistingCommentWidget receives the bag and self-manages composer state
  // (one open reply per thread, multiple threads can host open replies
  // simultaneously — matches the GitHub UX precedent).
  const replyContext = {
    prRef,
    prState,
    draftReplies: draftSession.session?.draftReplies ?? [],
    registerOpenComposer: draftSession.registerOpenComposer,
    onReplyComposerClose: () => {
      void draftSession.refetch();
    },
  };

  return (
    <div className="files-tab">
      <div className="files-tab-toolbar">
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
      </div>

      {diff.error && (
        <div role="alert" className="files-tab-error">
          Failed to load diff — {diff.error.message}
        </div>
      )}

      <div className="files-tab-content">
        <div className="files-tab-tree">
          {diff.showSkeleton ? (
            <div className="file-tree-skeleton" aria-label="Loading files" aria-busy="true">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : (
            <FileTree
              files={files}
              selectedPath={selectedPath}
              onSelectFile={setSelectedPath}
              viewedPaths={viewedPaths}
              onToggleViewed={handleToggleViewed}
              isLoading={diff.isLoading}
            />
          )}
        </div>
        <div className="files-tab-diff">
          <DiffPane
            selectedPath={selectedPath}
            file={selectedFile}
            diffMode={effectiveDiffMode}
            truncated={diff.data?.truncated ?? false}
            reviewThreads={fileThreads}
            prUrl={prUrl}
            onLineClick={handleLineClick}
            renderComposerForLine={renderComposerForLine}
            replyContext={replyContext}
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
