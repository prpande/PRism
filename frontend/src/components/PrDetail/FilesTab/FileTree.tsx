import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useContext,
  createContext,
} from 'react';
import type { FileChange, FileChangeStatus, FileFocus, FocusLevel } from '../../../api/types';
import { buildTree, type TreeNode, type FileTreeNode, type DirectoryTreeNode } from './treeBuilder';
import styles from './FileTree.module.css';

// Per-row name regions scroll horizontally to reveal long names; the status
// badge (left) and the viewed checkbox (right) sit OUTSIDE these regions so they
// stay fixed — the checkbox column never moves on scroll. This context hands
// each region a ref callback so a freshly-mounted row adopts the shared scroll
// position; ongoing sync is done by a capture-phase scroll listener on the root.
const NameScrollContext = createContext<(el: HTMLDivElement | null) => void>(() => {});

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

const STATUS_WORD: Record<string, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
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

  // Synchronize horizontal scroll across every per-row name region so the tree
  // scrolls as one unit (VS Code-like) while the checkbox column stays fixed.
  const rootRef = useRef<HTMLDivElement>(null);
  const sharedScrollLeft = useRef(0);
  const registerNameScroll = useCallback((el: HTMLDivElement | null) => {
    // A newly-mounted region (e.g. on directory expand) adopts the shared offset.
    if (el) el.scrollLeft = sharedScrollLeft.current;
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // scroll events don't bubble, so listen in the capture phase.
    const onScroll = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains('file-tree-name-scroll'))
        return;
      const x = target.scrollLeft;
      if (x === sharedScrollLeft.current) return;
      sharedScrollLeft.current = x;
      root.querySelectorAll<HTMLElement>('.file-tree-name-scroll').forEach((el) => {
        if (el !== target && el.scrollLeft !== x) el.scrollLeft = x;
      });
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, []);

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
    <NameScrollContext.Provider value={registerNameScroll}>
      <div
        ref={rootRef}
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
    </NameScrollContext.Provider>
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
  const registerNameScroll = useContext(NameScrollContext);
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
        aria-hidden="true"
      >
        {STATUS_LABELS[node.file.status] ?? '?'}
      </span>
      {/* sr-only status word BEFORE the name; trailing space separates it from the filename when spoken */}
      <span className="sr-only">{`${STATUS_WORD[node.file.status] ?? 'Unknown'} `}</span>
      {/* Only the name scrolls horizontally; badge (left) and ai/checkbox (right) stay fixed. */}
      <div
        className={`file-tree-name-scroll ${styles.fileTreeNameScroll}`}
        ref={registerNameScroll}
      >
        <span
          title={node.name}
          className={`file-tree-file-name ${styles.fileTreeFileName}${
            node.file.status === 'deleted'
              ? ` file-tree-file-name--deleted ${styles.fileTreeFileNameDeleted}`
              : ''
          }`}
        >
          {node.name}
        </span>
      </div>
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
  const registerNameScroll = useContext(NameScrollContext);

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
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            className={`file-tree-folder-icon ${styles.fileTreeFolderIcon}`}
          >
            <path
              d="M1.5 4.5a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
              fill="currentColor"
            />
          </svg>
        </button>
        <div
          className={`file-tree-name-scroll ${styles.fileTreeNameScroll}`}
          ref={registerNameScroll}
        >
          <span className={`file-tree-dir-name ${styles.fileTreeDirName}`} title={node.name}>
            {node.name}
          </span>
        </div>
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
