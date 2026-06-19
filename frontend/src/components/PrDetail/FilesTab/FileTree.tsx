import { useState, useCallback, useMemo, useRef } from 'react';
import type {
  FileChange,
  FileChangeStatus,
  FileFocus,
  FileFocusStatus,
  FocusLevel,
} from '../../../api/types';
import { AiMarker } from '../../Ai/AiMarker';
import { buildTree, type TreeNode, type FileTreeNode, type DirectoryTreeNode } from './treeBuilder';
import { useTreeHScroll } from '../../../hooks/useTreeHScroll';
import styles from './FileTree.module.css';
import { SampleBadge } from '../../Ai/SampleBadge';

export interface FileTreeProps {
  files: FileChange[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  viewedPaths: Set<string>;
  onToggleViewed: (path: string) => void;
  isLoading?: boolean;
  focusEntries: FileFocus[] | null;
  focusStatus: FileFocusStatus;
  // #508 (B1) — the PR-wide hunk-annotation fetch (lifted to FilesTab) is still in
  // flight. The one header marker spans BOTH AI passes: it stays "working" while
  // focus OR annotations are loading, so the cue doesn't drop to idle the moment
  // focus resolves while annotations are still arriving. Default false for callers
  // that don't wire annotations (tests / non-FilesTab).
  annotationsLoading?: boolean;
  aiPreview: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const STATUS_WORD: Record<FileChangeStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

// File rows indent one level deeper than their parent directory header
// ((depth + 1) vs depth) so a file sits visually inside its folder; a depth-0 file
// (no parent dir) still gets one level of indent.
const INDENT_PER_LEVEL = 12;

const FILE_STATUS_MODULE: Record<FileChangeStatus, string> = {
  added: styles.fileStatusAdded,
  modified: styles.fileStatusModified,
  deleted: styles.fileStatusDeleted,
  renamed: styles.fileStatusRenamed,
};

// The tree renders as a flat, ordered list of rows so the scrolling tree column
// and the fixed checkbox column can be rendered from the SAME sequence — row i in
// one lines up with slot i in the other. Directory expand/collapse state is lifted
// here (a Set of collapsed directory keys) rather than living in each row, which is
// what makes the flat list — and therefore the two aligned columns — possible.
interface FileRow {
  kind: 'file';
  key: string;
  depth: number;
  node: FileTreeNode;
  setSize: number;
  posInSet: number;
}
interface DirRow {
  kind: 'dir';
  key: string;
  depth: number;
  node: DirectoryTreeNode;
  dirKey: string;
  expanded: boolean;
  setSize: number;
  posInSet: number;
}
type RenderRow = FileRow | DirRow;

// Directory nodes carry only a (possibly duplicated) compacted name, so collapse
// state is keyed by the ancestor chain joined with a NUL separator — unique and
// stable across re-renders. NUL cannot appear in a path segment.
const DIR_KEY_SEP = String.fromCharCode(0);
// The tree renders flat (siblings of one role=tree), not via nested role=group
// wrappers, because the same flat row list also drives the fixed checkbox column.
// A flat ARIA tree must therefore carry aria-level AND aria-setsize/aria-posinset so
// assistive tech can still infer per-level grouping — `setSize`/`posInSet` are the
// count of, and 1-based position within, this node's sibling group.
function buildRows(
  nodes: TreeNode[],
  collapsed: Set<string>,
  depth: number,
  parentKey: string,
  out: RenderRow[],
): void {
  const setSize = nodes.length;
  nodes.forEach((node, i) => {
    const posInSet = i + 1;
    if (node.kind === 'file') {
      out.push({ kind: 'file', key: `file:${node.path}`, depth, node, setSize, posInSet });
    } else {
      const dirKey = parentKey ? parentKey + DIR_KEY_SEP + node.name : node.name;
      const expanded = !collapsed.has(dirKey);
      out.push({
        kind: 'dir',
        key: `dir:${dirKey}`,
        depth,
        node,
        dirKey,
        expanded,
        setSize,
        posInSet,
      });
      if (expanded) buildRows(node.children, collapsed, depth + 1, dirKey, out);
    }
  });
}

export function FileTree({
  files,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  isLoading = false,
  focusEntries,
  focusStatus,
  annotationsLoading = false,
  aiPreview,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const viewedCount = useMemo(
    () => files.filter((f) => viewedPaths.has(f.path)).length,
    [files, viewedPaths],
  );

  // Collapse state intentionally persists across `files` changes (e.g. a background
  // freshness refetch): a dir the user collapsed stays collapsed on reload. Stale
  // keys for dirs that no longer exist are harmless — they just sit unused, and any
  // collapsed dir always has a chevron to re-expand it.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleDir = useCallback((dirKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dirKey)) next.delete(dirKey);
      else next.add(dirKey);
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    const out: RenderRow[] = [];
    buildRows(tree, collapsed, 0, '', out);
    return out;
  }, [tree, collapsed]);

  const focusByPath = useMemo(() => {
    if (!focusEntries) return null;
    const m = new Map<string, FocusLevel>();
    for (const entry of focusEntries) m.set(entry.path, entry.level);
    return m;
  }, [focusEntries]);

  // One header cue for the whole tree (spec §3 — never per-row). Working while EITHER
  // AI pass is in flight — the shared file-focus fetch OR the PR-wide hunk-annotation
  // fetch — so the cue spans the whole "AI working" window instead of dropping to idle
  // the instant focus resolves while annotations are still loading. A PERSISTENT idle
  // "AI is on here" marker once focus has run (ok/empty/fallback) and annotations are
  // no longer loading — idle on empty is the truthful "AI ran, flagged nothing" signal
  // that dots alone cannot express. Hidden when AI is off (no-changes/not-subscribed)
  // or focus errored (and nothing is loading).
  let headerMarkerState: 'working' | 'idle' | null = null;
  if (aiPreview) {
    if (focusStatus === 'loading' || annotationsLoading) {
      headerMarkerState = 'working';
    } else if (focusStatus === 'ok' || focusStatus === 'empty' || focusStatus === 'fallback') {
      headerMarkerState = 'idle';
    }
  }

  // #214 — synthetic, bottom-pinned horizontal scrollbar. The clipped tree column
  // (.fileTreeScroll) is shifted via translateX from this bar's scrollLeft, so the bar
  // (a sticky footer below) is reachable without scrolling the tree to its end. Refs stay
  // null on the empty/loading render paths below; useTreeHScroll null-guards those.
  const scrollRef = useRef<HTMLDivElement>(null);
  const hScrollRowRef = useRef<HTMLDivElement>(null);
  const hScrollRef = useRef<HTMLDivElement>(null);
  const hScrollSpacerRef = useRef<HTMLDivElement>(null);
  useTreeHScroll(scrollRef, hScrollRowRef, hScrollRef, hScrollSpacerRef, rows.length > 0, [rows]);

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
      data-testid="file-tree"
      // #492 — drives the AI column width AND the synthetic-hscroll spacer reservation
      // in lockstep (CSS), so the fixed AI gutter appears only in Preview/Live and the
      // scrollbar keeps spanning the tree column only. Set from the prop at render — no
      // post-mount flash.
      data-ai-on={aiPreview ? '1' : '0'}
    >
      <div className={`file-tree-header ${styles.fileTreeHeader}`}>
        <span className={styles.fileTreeHeaderLabel}>
          Files · {viewedCount}/{files.length} viewed
          {aiPreview && <SampleBadge variant="region" />}
        </span>
        {headerMarkerState && (
          <span data-testid="file-tree-ai-progress" data-ai-state={headerMarkerState}>
            <AiMarker
              variant="inline"
              state={headerMarkerState}
              decorative
              className={`${styles.fileTreeHeaderAi}${headerMarkerState === 'idle' ? ` ${styles.fileTreeHeaderAiIdle}` : ''}`}
            />
          </span>
        )}
      </div>
      <div className={styles.fileTreeBody}>
        <div
          ref={scrollRef}
          className={`file-tree-scroll ${styles.fileTreeScroll}`}
          role="tree"
          aria-label="File tree"
        >
          <div className={`file-tree-inner ${styles.fileTreeInner}`}>
            {rows.map((row) =>
              row.kind === 'dir' ? (
                <DirCell key={row.key} row={row} onToggle={toggleDir} />
              ) : (
                <FileCell
                  key={row.key}
                  row={row}
                  isSelected={selectedPath === row.node.path}
                  isViewed={viewedPaths.has(row.node.path)}
                  onSelectFile={onSelectFile}
                  focusLevel={focusByPath?.get(row.node.path) ?? null}
                />
              ),
            )}
          </div>
        </div>
        {/* #492 — AI focus column. A fixed column OUTSIDE .fileTreeScroll (like the
            checkbox column), so the dot stays visible at any horizontal scroll position
            instead of riding off-screen at the end of a long filename. Rendered from the
            same flat `rows` list so row i lines up across all three columns. Collapses to
            0 width when AI is off (data-ai-on on the root), and is aria-hidden — the
            spoken "AI focus: <level>" signal lives in the row after the filename. */}
        <div className={`file-tree-ai-col ${styles.fileTreeAiCol}`} aria-hidden="true">
          {rows.map((row) =>
            row.kind === 'file' ? (
              <AiSlot
                key={row.key}
                focusLevel={focusByPath?.get(row.node.path) ?? null}
                aiPreview={aiPreview}
              />
            ) : (
              <div key={row.key} className={styles.fileTreeAiSlot} />
            ),
          )}
        </div>
        {/* Checkbox column — a separate object that never scrolls horizontally, so the
            checkboxes stay fixed while names scroll. It shares the outer pane's vertical
            scroll with the tree (plain content-height siblings), so no border/seam and no
            JS sync: the two columns read as one surface. */}
        <div
          className={`file-tree-check-col ${styles.fileTreeCheckCol}`}
          role="group"
          aria-label="Mark files viewed"
        >
          {rows.map((row) =>
            row.kind === 'file' ? (
              <CheckSlot
                key={row.key}
                node={row.node}
                isViewed={viewedPaths.has(row.node.path)}
                onToggleViewed={onToggleViewed}
              />
            ) : (
              <div key={row.key} className={styles.fileTreeCheckSlot} aria-hidden="true" />
            ),
          )}
        </div>
      </div>
      {/* #214 — synthetic horizontal scrollbar, pinned to the bottom of the visible tree
          pane. A sticky footer OUTSIDE the content-height tree body (so it stays reachable
          without scrolling the tree to its end), mirroring .fileTreeBody's two-column
          layout so the bar aligns under .fileTreeScroll and the thumb proportion stays
          honest. aria-hidden + non-tabbable, matching DiffPane's .diffHScroll: it is a
          pointer/trackpad affordance; full names reach assistive tech via the row title.
          useTreeHScroll toggles `display` so it shows only when the tree overflows. */}
      <div
        ref={hScrollRowRef}
        className={`file-tree-hscroll-row ${styles.fileTreeHScrollRow}`}
        aria-hidden="true"
      >
        <div
          ref={hScrollRef}
          className={`file-tree-hscroll ${styles.fileTreeHScroll}`}
          data-testid="file-tree-hscroll"
        >
          <div ref={hScrollSpacerRef} className={styles.fileTreeHScrollSpacer} />
        </div>
        <div className={styles.fileTreeHScrollSpacerCol} />
      </div>
    </div>
  );
}

function FileCell({
  row,
  isSelected,
  isViewed,
  onSelectFile,
  focusLevel,
}: {
  row: FileRow;
  isSelected: boolean;
  isViewed: boolean;
  onSelectFile: (path: string) => void;
  focusLevel: FocusLevel | null;
}) {
  const node = row.node;
  return (
    <div
      className={`file-tree-file${isSelected ? ' file-tree-file--selected' : ''}${
        isViewed ? ' file-tree-file--viewed' : ''
      } ${styles.fileTreeFile}${isSelected ? ` ${styles.fileTreeFileSelected}` : ''}${
        isViewed ? ` ${styles.fileTreeFileViewed}` : ''
      }`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-selected={isSelected}
      data-testid="files-tab-tree-row"
      data-selected={isSelected}
      data-path={node.path}
      style={{ paddingLeft: `${(row.depth + 1) * INDENT_PER_LEVEL}px` }}
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
      {/* #492 — the VISUAL dot moved to the fixed .file-tree-ai-col (so it can't scroll
          off with a long name). The spoken signal stays here, after the filename, so the
          screen-reader reading order (status word → name → AI focus) is unchanged. */}
      {focusLevel && focusLevel !== 'low' && (
        <span className="sr-only">{` AI focus: ${focusLevel}`}</span>
      )}
    </div>
  );
}

// #492 — one slot per file row in the fixed .file-tree-ai-col. The `.file-tree-ai`
// span and its inner High/Medium dot are unchanged from the old in-row markup (same
// data-on gate, title, aria-hidden); only the location moved. Directory rows render a
// bare .fileTreeAiSlot (no .file-tree-ai), so the `count === files.length` invariant
// holds. Two gates compose intentionally (spec Mechanics §5): the column-level
// data-ai-on gate on the root collapses the whole gutter when AI is off, and this
// per-span data-on is the original, untouched marker gate kept in place by the issue's
// scope guard ("don't change the data-on Preview/Live gating"). When AI is off the
// column is already width-0, so the per-span collapse isn't visible — `aiPreview` is
// still threaded here only to preserve that pre-existing gate verbatim, not because
// the slot needs it to hide.
function AiSlot({ focusLevel, aiPreview }: { focusLevel: FocusLevel | null; aiPreview: boolean }) {
  return (
    <div className={styles.fileTreeAiSlot}>
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
    </div>
  );
}

function CheckSlot({
  node,
  isViewed,
  onToggleViewed,
}: {
  node: FileTreeNode;
  isViewed: boolean;
  onToggleViewed: (path: string) => void;
}) {
  // onChange (not onClick + readOnly) so Space-key activation toggles consistently
  // across browsers. The checkbox lives in its own column, so no row-level click to
  // stop from bubbling.
  const handleChange = useCallback(() => {
    onToggleViewed(node.path);
  }, [onToggleViewed, node.path]);

  return (
    <div className={styles.fileTreeCheckSlot}>
      <input
        type="checkbox"
        checked={isViewed}
        onChange={handleChange}
        aria-label={`Viewed ${node.path}`}
        className={`file-tree-viewed-checkbox ${styles.fileTreeViewedCheckbox}`}
      />
    </div>
  );
}

function DirCell({ row, onToggle }: { row: DirRow; onToggle: (dirKey: string) => void }) {
  const node = row.node;
  const { expanded } = row;
  return (
    <div
      className={`file-tree-dir-header ${styles.fileTreeDirHeader}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={expanded}
      style={{ paddingLeft: `${row.depth * INDENT_PER_LEVEL}px` }}
    >
      <button
        className={`file-tree-dir-toggle ${styles.fileTreeDirToggle}`}
        onClick={() => onToggle(row.dirKey)}
        aria-label={`Toggle ${node.name}`}
        aria-expanded={expanded}
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
      <span className={`file-tree-dir-name ${styles.fileTreeDirName}`} title={node.name}>
        {node.name}
      </span>
    </div>
  );
}
