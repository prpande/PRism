import { useState, useCallback, useMemo } from 'react';
import type { FileChange } from '../../../api/types';
import { buildTree, type TreeNode, type FileTreeNode, type DirectoryTreeNode } from './treeBuilder';

export interface FileTreeProps {
  files: FileChange[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

export function FileTree({
  files,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const viewedCount = files.filter((f) => viewedPaths.has(f.path)).length;

  if (files.length === 0) {
    return (
      <div className="file-tree">
        <div className="file-tree-header">Files</div>
        <p className="file-tree-empty muted">No files in this diff.</p>
      </div>
    );
  }

  return (
    <div className="file-tree" role="tree" aria-label="File tree">
      <div className="file-tree-header">
        Files · {viewedCount}/{files.length} viewed
      </div>
      <div className="file-tree-list">
        {tree.map((node) => (
          <TreeNodeComponent
            key={nodeKey(node)}
            node={node}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            viewedPaths={viewedPaths}
            onToggleViewed={onToggleViewed}
            depth={0}
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
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  depth: number;
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
}: {
  node: FileTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  depth: number;
}) {
  const isSelected = selectedPath === node.path;
  const isViewed = viewedPaths.has(node.path);

  const handleCheckboxClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleViewed(node.path);
    },
    [onToggleViewed, node.path],
  );

  return (
    <div
      className={`file-tree-file${isSelected ? ' file-tree-file--selected' : ''}`}
      role="treeitem"
      data-selected={isSelected}
      data-path={node.path}
      style={{ paddingLeft: `${(depth + 1) * 16}px` }}
      onClick={() => onSelectFile(node.path)}
      tabIndex={isSelected ? 0 : -1}
    >
      <span className={`file-status file-status--${node.file.status}`}>
        {STATUS_LABELS[node.file.status] ?? '?'}
      </span>
      <span className="file-tree-file-name">{node.name}</span>
      <span className="file-tree-spacer" />
      <input
        type="checkbox"
        checked={isViewed}
        onChange={() => {}} // controlled via click handler
        onClick={handleCheckboxClick}
        aria-label={`Viewed ${node.name}`}
        className="file-tree-viewed-checkbox"
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
}: {
  node: DirectoryTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="file-tree-dir" role="group">
      <div className="file-tree-dir-header" style={{ paddingLeft: `${depth * 16}px` }}>
        <button
          className="file-tree-dir-toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-label={`Toggle ${node.name}`}
          aria-expanded={expanded}
        >
          <span className={`file-tree-chevron${expanded ? ' file-tree-chevron--open' : ''}`}>
            ▸
          </span>
        </button>
        <span className="file-tree-dir-name">{node.name}</span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeNodeComponent
            key={nodeKey(child)}
            node={child}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            viewedPaths={viewedPaths}
            onToggleViewed={onToggleViewed}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
