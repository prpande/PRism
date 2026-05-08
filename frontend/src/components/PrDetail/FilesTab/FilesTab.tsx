import { useState, useCallback, useMemo } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import type { PrDetailDto, PrReference } from '../../../api/types';
import { postFileViewed } from '../../../api/fileViewed';
import { useFileDiff } from '../../../hooks/useFileDiff';
import { useUnionDiff } from '../../../hooks/useUnionDiff';
import { useFilesTabShortcuts } from '../../../hooks/useFilesTabShortcuts';
import { FileTree } from './FileTree';
import { DiffPane } from './DiffPane';
import { IterationTabStrip } from './IterationTabStrip';
import { CommitMultiSelectPicker } from './CommitMultiSelectPicker';
import { buildTree, flattenPaths } from './treeBuilder';

interface FilesTabContext {
  prDetail: PrDetailDto;
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

  const handleRangeChange = useCallback((range: string) => {
    setActiveRange(range);
    setSelectedPath(null);
  }, []);

  const handleCommitsChange = useCallback((shas: string[] | null) => {
    setSelectedCommits(shas);
    setSelectedPath(null);
  }, []);
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(new Set());

  const allRange = `${prDetail.pr.baseSha}..${prDetail.pr.headSha}`;

  const iterationRange = useMemo(() => {
    if (isLowQuality) return null;
    if (activeRange === 'all') return allRange;
    return activeRange;
  }, [isLowQuality, activeRange, allRange]);

  // For OK quality: fetch by range (iteration-based)
  const rangeDiff = useFileDiff(prRef, isLowQuality ? null : iterationRange);

  // For low quality + "show all": also fetch by range
  const lowAllDiff = useFileDiff(prRef, isLowQuality && selectedCommits === null ? allRange : null);

  // For low quality + specific commits selected
  const commitsDiff = useUnionDiff(
    prRef,
    isLowQuality && selectedCommits !== null ? selectedCommits : null,
  );

  const diff = isLowQuality ? (selectedCommits === null ? lowAllDiff : commitsDiff) : rangeDiff;

  const files = diff.data?.files ?? [];
  const tree = useMemo(() => buildTree(files), [files]);
  const fileList = useMemo(() => flattenPaths(tree), [tree]);

  const handleToggleViewed = useCallback(
    (path: string) => {
      const wasViewed = viewedPaths.has(path);
      const newViewed = !wasViewed;

      setViewedPaths((prev) => {
        const next = new Set(prev);
        if (newViewed) next.add(path);
        else next.delete(path);
        return next;
      });

      postFileViewed(prRef, {
        path,
        headSha: prDetail.pr.headSha,
        viewed: newViewed,
      }).catch(() => {
        setViewedPaths((prev) => {
          const next = new Set(prev);
          if (wasViewed) next.add(path);
          else next.delete(path);
          return next;
        });
      });
    },
    [prRef, prDetail.pr.headSha, viewedPaths],
  );

  const handleNextFile = useCallback(() => {
    if (fileList.length === 0) return;
    const idx = selectedPath ? fileList.indexOf(selectedPath) : -1;
    const next = (idx + 1) % fileList.length;
    setSelectedPath(fileList[next]);
  }, [fileList, selectedPath]);

  const handlePrevFile = useCallback(() => {
    if (fileList.length === 0) return;
    const idx = selectedPath ? fileList.indexOf(selectedPath) : 0;
    const prev = (idx - 1 + fileList.length) % fileList.length;
    setSelectedPath(fileList[prev]);
  }, [fileList, selectedPath]);

  const handleToggleDiffMode = useCallback(() => {
    // Diff mode toggle will be wired in Task 8
  }, []);

  useFilesTabShortcuts({
    onNextFile: handleNextFile,
    onPrevFile: handlePrevFile,
    onToggleViewed: () => {
      if (selectedPath) handleToggleViewed(selectedPath);
    },
    onToggleDiffMode: handleToggleDiffMode,
  });

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
            />
          )}
        </div>
        <div className="files-tab-diff">
          <DiffPane selectedPath={selectedPath} />
        </div>
      </div>
    </div>
  );
}
