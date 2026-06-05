import { useState, useCallback, useMemo } from 'react';
import type { FileChange, FileChangeStatus, FileFocus, FocusLevel } from '../../../api/types';
import { buildTree, type TreeNode, type FileTreeNode, type DirectoryTreeNode } from './treeBuilder';
import styles from './FileTree.module.css';

export interface FileTreeProps {
  files: FileChange[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  isLoading?: boolean;
  focusEntries: FileFocus[] | null;
  aiPreview: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const INDENT_PER_LEVEL = 12;

const FILE_STATUS_MODULE: Record<FileChangeStatus, string> = {
  added: styles.fileStatusAdded,
  modified: styles.fileStatusModified,
  deleted: styles.fileStatusDeleted,
  renamed: styles.fileStatusRenamed,
};

export function FileTree({
  files,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  isLoading = false,
  focusEntries,
  aiPreview,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const viewedCount = files.filter((f) => viewedPaths.has(f.path)).length;

  const focusByPath = useMemo(() => {
    if (!focusEntries) return null;
    const m = new Map<string, FocusLevel>();
    for (const entry of focusEntries) m.set(entry.path, entry.level);
    return m;
  }, [focusEntries]);

  if (files.length === 0) {
    if (isLoading) return null;
    return (
      <div className={`file-tree ${styles.fileTree}`} data-testid="file-tree">
        <div className={`file-tree-header ${styles.fileTreeHeader}`}>Files</div>
        <p className={`file-tree-empty muted ${styles.fileTreeEmpty}`}>No files in this diff.</p>
      </div>
    );
  }

  return (
    <div
      className={`file-tree ${styles.fileTree}`}
      role="tree"
      aria-label="File tree"
      data-testid="file-tree"
    >
      <div className={`file-tree-header ${styles.fileTreeHeader}`}>
        Files · {viewedCount}/{files.length} viewed
      </div>
      <div className={`file-tree-list ${styles.fileTreeList}`}>
        {tree.map((node) => (
          <TreeNodeComponent
            key={nodeKey(node)}
            node={node}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            viewedPaths={viewedPaths}
            onToggleViewed={onToggleViewed}
            depth={0}
            focusByPath={focusByPath}
            aiPreview={aiPreview}
          />
        ))}
      </div>
    </div>
  );
}

function nodeKey(node: TreeNode): string {
  return node.kind === 'file' ? (node as FileTreeNode).path : (node as DirectoryTreeNode).name;
}

function TreeNodeComponent({
  node,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  depth,
  focusByPath,
  aiPreview,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  depth: number;
  focusByPath: Map<string, FocusLevel> | null;
  aiPreview: boolean;
}) {
  if (node.kind === 'file') {
    return (
      <FileNodeComponent
        node={node}
        selectedPath={selectedPath}
        onSelectFile={onSelectFile}
        viewedPaths={viewedPaths}
        onToggleViewed={onToggleViewed}
        depth={depth}
        focusByPath={focusByPath}
        aiPreview={aiPreview}
      />
    );
  }
  return (
    <DirectoryNodeComponent
      node={node}
      selectedPath={selectedPath}
      onSelectFile={onSelectFile}
      viewedPaths={viewedPaths}
      onToggleViewed={onToggleViewed}
      depth={depth}
      focusByPath={focusByPath}
      aiPreview={aiPreview}
    />
  );
}

function FileNodeComponent({
  node,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  depth,
  focusByPath,
  aiPreview,
}: {
  node: FileTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  depth: number;
  focusByPath: Map<string, FocusLevel> | null;
  aiPreview: boolean;
}) {
  const isSelected = selectedPath === node.path;
  const isViewed = viewedPaths.has(node.path);
  const focusLevel = focusByPath?.get(node.path) ?? null;

  // onChange (not onClick + readOnly) so Space-key activation toggles the
  // checkbox consistently across browsers (claude[bot] iter 1 #10). The
  // stopPropagation guard still applies to the click path so toggling the
  // checkbox does not bubble to the row-level onSelectFile handler.
  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);
  const handleCheckboxChange = useCallback(() => {
    onToggleViewed(node.path);
  }, [onToggleViewed, node.path]);

  return (
    <div
      className={`file-tree-file${isSelected ? ' file-tree-file--selected' : ''} ${styles.fileTreeFile}${isSelected ? ` ${styles.fileTreeFileSelected}` : ''}`}
      role="treeitem"
      data-testid="files-tab-tree-row"
      data-selected={isSelected}
      data-path={node.path}
      style={{ paddingLeft: `${(depth + 1) * INDENT_PER_LEVEL}px` }}
      onClick={() => onSelectFile(node.path)}
      tabIndex={isSelected ? 0 : -1}
    >
      <span
        className={`file-status file-status--${node.file.status} ${styles.fileStatus} ${FILE_STATUS_MODULE[node.file.status]}`}
      >
        {STATUS_LABELS[node.file.status] ?? '?'}
      </span>
      <span className={`file-tree-file-name ${styles.fileTreeFileName}`}>{node.name}</span>
      <span className={`file-tree-spacer ${styles.fileTreeSpacer}`} />
      <span
        className={`file-tree-ai ${styles.fileTreeAi}`}
        data-on={aiPreview ? '1' : '0'}
        aria-hidden="true"
      >
        {focusLevel && focusLevel !== 'low' && (
          <span
            className={focusLevel === 'high' ? styles.fileTreeAiHigh : styles.fileTreeAiMed}
            title={`AI focus: ${focusLevel}`}
          />
        )}
      </span>
      {focusLevel && focusLevel !== 'low' && (
        <span className="sr-only">{` AI focus: ${focusLevel}`}</span>
      )}
      <input
        type="checkbox"
        checked={isViewed}
        onChange={handleCheckboxChange}
        onClick={handleCheckboxClick}
        aria-label={`Viewed ${node.name}`}
        className={`file-tree-viewed-checkbox ${styles.fileTreeViewedCheckbox}`}
      />
    </div>
  );
}

function DirectoryNodeComponent({
  node,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  depth,
  focusByPath,
  aiPreview,
}: {
  node: DirectoryTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  depth: number;
  focusByPath: Map<string, FocusLevel> | null;
  aiPreview: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`file-tree-dir ${styles.fileTreeDir}`} role="treeitem" aria-expanded={expanded}>
      <div
        className={`file-tree-dir-header ${styles.fileTreeDirHeader}`}
        style={{ paddingLeft: `${depth * INDENT_PER_LEVEL}px` }}
      >
        <button
          className={`file-tree-dir-toggle ${styles.fileTreeDirToggle}`}
          onClick={() => setExpanded((e) => !e)}
          aria-label={`Toggle ${node.name}`}
        >
          <span
            className={`file-tree-chevron${expanded ? ' file-tree-chevron--open' : ''} ${styles.fileTreeChevron}${expanded ? ` ${styles.fileTreeChevronOpen}` : ''}`}
          >
            ▸
          </span>
        </button>
        <span className={`file-tree-dir-name ${styles.fileTreeDirName}`}>{node.name}</span>
      </div>
      {expanded && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNodeComponent
              key={nodeKey(child)}
              node={child}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              viewedPaths={viewedPaths}
              onToggleViewed={onToggleViewed}
              depth={depth + 1}
              focusByPath={focusByPath}
              aiPreview={aiPreview}
            />
          ))}
        </div>
      )}
    </div>
  );
}
