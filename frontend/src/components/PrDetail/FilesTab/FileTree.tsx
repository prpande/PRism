import type React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import type {
  FileChange,
  FileChangeStatus,
  FileFocus,
  FileFocusStatus,
  FocusLevel,
} from '../../../api/types';
import { AiMarker } from '../../Ai/AiMarker';
import { AI_TREE_ANALYZED_LABEL } from '../../Ai/aiStrings';
import { fileFocusStatusToMarkerState } from '../../Ai/fileFocusMarkerState';
import type { TreeNode, FileTreeNode, DirectoryTreeNode } from './treeBuilder';
import { useTreeHScroll } from '../../../hooks/useTreeHScroll';
import { countViewedFiles } from '../../../hooks/useFileViewState';
import { CommentGlyph } from '../../shared/CommentGlyph';
import { commentTooltip } from './commentIndicatorState';
import type { CommentIndicatorState, CommentCounts } from './commentIndicatorState';
import styles from './FileTree.module.css';

export interface FileTreeProps {
  files: FileChange[];
  // #327 (Task 9) — the tree built from `files` by FilesTab's buildTree memo (it already
  // needs the tree for its flattened path list), passed down so the tree is built ONCE.
  // `files` stays alongside it: the empty-state gate, the header viewed tally, and
  // countViewedFiles all read the flat list.
  tree: TreeNode[];
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
  // #513 — per-file comment state. Optional/nullable ONLY so non-FilesTab callers
  // (tests, future embeds) can omit it; FilesTab always passes a real Map (possibly
  // empty). Null/empty ⇒ rail collapsed (data-has-comments='0'), every slot blank —
  // mirroring how aiPreview defaults false.
  commentStateByPath?: Map<string, CommentIndicatorState> | null;
  // #513 — per-file thread tallies for the comment-glyph hover tooltip. Same
  // optional/nullable contract as commentStateByPath; absent ⇒ no tooltip.
  commentCountsByPath?: Map<string, CommentCounts> | null;
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

// Vertical-only reveal for keyboard focus. focus() always runs with preventScroll: a
// native focus-scroll would write scrollLeft on the overflow-clipped viewport and desync
// the #214 synthetic h-scrollbar, whose CSS-var/translateX mechanism is the sole
// horizontal authority. This restores block-nearest visibility by adjusting the nearest
// scrollable-Y ancestor's scrollTop only. The #214 footer is `position: sticky; bottom: 0`
// INSIDE that scrollport and overlays its bottom edge while the tree overflows
// horizontally; .filesTabTree's scroll-padding-bottom covers only native scrollIntoView,
// not manual scrollTop math, so the live footer height is reserved here explicitly.
// Module-scope (no component state) and exported so tests can drive it with stubbed
// geometry — jsdom reports zero layout, so the in-tree path never runs under RTL.
export function revealTreeRow(el: HTMLElement): void {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1) {
      const overflowY = getComputedStyle(p).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        const pr = p.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        const footer = p.querySelector('.file-tree-hscroll-row');
        const clearance =
          footer && getComputedStyle(footer).display !== 'none'
            ? footer.getBoundingClientRect().height
            : 0;
        if (er.top < pr.top) p.scrollTop += er.top - pr.top;
        else if (er.bottom > pr.bottom - clearance)
          p.scrollTop += er.bottom - (pr.bottom - clearance);
        return;
      }
    }
  }
}
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
  tree,
  selectedPath,
  onSelectFile,
  viewedPaths,
  onToggleViewed,
  isLoading = false,
  focusEntries,
  focusStatus,
  annotationsLoading = false,
  aiPreview,
  commentStateByPath = null,
  commentCountsByPath = null,
}: FileTreeProps) {
  const viewedCount = useMemo(() => countViewedFiles(files, viewedPaths), [files, viewedPaths]);

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

  // #200 — WAI-ARIA tree keyboard model on the flat rows list. One roving tab stop across
  // ALL rows (directories included): the last-focused row while it still exists, else the
  // selected file's row, else the first row. DOM focus moves imperatively through a
  // row-element map keyed by RenderRow.key — NOT querySelector, whose attribute selectors
  // cannot match the NUL separator inside dir keys. No deferred-focus effect exists: every
  // key's focus target is already rendered (expand/collapse keep focus on the dir row
  // itself; move-into fires only when the child row is present), so a background files
  // refetch structurally cannot yank focus anywhere (spec AC 12).
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rowElsRef = useRef(new Map<string, HTMLElement>());
  const setRowEl = useCallback((key: string, el: HTMLElement | null) => {
    if (el) rowElsRef.current.set(key, el);
    else rowElsRef.current.delete(key);
  }, []);
  const handleRowFocus = useCallback((key: string) => {
    // React's onFocus is focusin-based (bubbles), so a chevron click that natively focuses
    // the inner button still syncs the roving stop to its row — mouse and keyboard can
    // never diverge (spec AC 11).
    setFocusedKey((prev) => (prev === key ? prev : key));
  }, []);

  const effectiveFocusedKey = useMemo(() => {
    if (focusedKey && rows.some((r) => r.key === focusedKey)) return focusedKey;
    if (selectedPath) {
      const sel = rows.find((r) => r.kind === 'file' && r.node.path === selectedPath);
      if (sel) return sel.key;
    }
    return rows.length > 0 ? rows[0].key : null;
  }, [focusedKey, rows, selectedPath]);

  const focusRowByKey = useCallback((key: string) => {
    const el = rowElsRef.current.get(key);
    if (!el) return;
    setFocusedKey(key);
    el.focus({ preventScroll: true });
    revealTreeRow(el);
  }, []);

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const idx = rows.findIndex((r) => r.key === effectiveFocusedKey);
      if (idx < 0) return;
      const current = rows[idx];
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': {
          if (idx + 1 < rows.length) focusRowByKey(rows[idx + 1].key);
          break;
        }
        case 'ArrowUp': {
          if (idx > 0) focusRowByKey(rows[idx - 1].key);
          break;
        }
        case 'ArrowRight': {
          if (current.kind === 'dir') {
            if (!current.expanded) {
              toggleDir(current.dirKey); // expand; focus stays on the dir row
            } else if (idx + 1 < rows.length && rows[idx + 1].depth > current.depth) {
              focusRowByKey(rows[idx + 1].key); // already expanded → first child
            }
          }
          break; // no-op on files (APG)
        }
        case 'ArrowLeft': {
          if (current.kind === 'dir' && current.expanded) {
            toggleDir(current.dirKey); // collapse; focus stays on the dir row
          } else {
            // Collapsed dir or file → nearest ancestor row. Ancestors always precede
            // descendants in the flat list, so the first shallower row upward is the parent
            // (correct under path compaction too — any depth delta qualifies).
            for (let i = idx - 1; i >= 0; i--) {
              if (rows[i].depth < current.depth) {
                focusRowByKey(rows[i].key);
                break;
              }
            }
          }
          break;
        }
        case 'Home': {
          if (rows.length > 0) focusRowByKey(rows[0].key);
          break;
        }
        case 'End': {
          if (rows.length > 0) focusRowByKey(rows[rows.length - 1].key);
          break;
        }
        case 'Enter':
        case ' ': {
          if (current.kind === 'file') onSelectFile(current.node.path);
          else toggleDir(current.dirKey);
          break;
        }
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    },
    [rows, effectiveFocusedKey, focusRowByKey, toggleDir, onSelectFile],
  );

  const focusByPath = useMemo(() => {
    if (!focusEntries) return null;
    const m = new Map<string, FocusLevel>();
    for (const entry of focusEntries) m.set(entry.path, entry.level);
    return m;
  }, [focusEntries]);

  const hasComments = (commentStateByPath?.size ?? 0) > 0;

  // #513 — full-row highlight. The four columns are separate DOM siblings, so a
  // per-row background must be painted on each column's slot from lifted state, not
  // via :hover on one column. hoveredPath holds a file path (slash-joined) or a dir
  // key (NUL-joined) — the two spaces never collide, so one string is unambiguous.
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const handleBodyMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-row-path],[data-row-key]');
    if (!el) return; // pointer over a gap — keep the current highlight (only leave clears)
    const id = el.getAttribute('data-row-path') ?? el.getAttribute('data-row-key');
    setHoveredPath((prev) => (prev === id ? prev : id));
  }, []);
  const handleBodyMouseLeave = useCallback(() => setHoveredPath(null), []);

  // One header cue for the whole tree (spec §3 — never per-row). Working while EITHER
  // AI pass is in flight — the shared file-focus fetch OR the PR-wide hunk-annotation
  // fetch — so the cue spans the whole "AI working" window instead of dropping to idle
  // the instant focus resolves while annotations are still loading. A PERSISTENT idle
  // "AI is on here" marker once focus has run (ok/empty/fallback) and annotations are
  // no longer loading — idle on empty is the truthful "AI ran, flagged nothing" signal
  // that dots alone cannot express. Hidden when AI is off (no-changes/not-subscribed)
  // or focus errored (and nothing is loading).
  // Header marker spans BOTH AI passes (file-focus ranking + hunk annotation): stays
  // `working` while either loads, else reflects focus status via the shared reduction.
  // Behavior identical to the Slice-1 inline form — fileFocusStatusToMarkerState('loading')
  // === 'working', so the original `focusStatus === 'loading' || annotationsLoading` OR is
  // preserved transitively. The helper is NOT the sole authority here; annotationsLoading
  // overrides it. Do not strip the annotationsLoading arm.
  const headerMarkerState: 'working' | 'idle' | null = aiPreview
    ? annotationsLoading
      ? 'working'
      : fileFocusStatusToMarkerState(focusStatus)
    : null;

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
        <div className={`file-tree-header ${styles.fileTreeHeader}`}>
          <span className={styles.fileTreeHeaderLabel}>Files</span>
        </div>
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
      // #513 — drives the fixed comment rail's width (collapses to 0 when the PR has
      // no threads), mirroring the data-ai-on gate above.
      data-has-comments={hasComments ? '1' : '0'}
    >
      <div className={`file-tree-header ${styles.fileTreeHeader}`}>
        <span className={styles.fileTreeHeaderLabel}>
          Files · {viewedCount}/{files.length} viewed
        </span>
        {headerMarkerState && (
          <span data-testid="file-tree-ai-progress" data-ai-state={headerMarkerState}>
            <AiMarker
              variant="inline"
              state={headerMarkerState}
              decorative
              className={`${styles.fileTreeHeaderAi}${headerMarkerState === 'idle' ? ` ${styles.fileTreeHeaderAiIdle}` : ''}`}
            />
            {/* The working marker carries a `title` tooltip; the idle marker is otherwise
                silent to AT (decorative glyph, no per-row focus signal on an empty result),
                so give it an sr-only label. */}
            {headerMarkerState === 'idle' && (
              <span className="sr-only">{AI_TREE_ANALYZED_LABEL}</span>
            )}
          </span>
        )}
      </div>
      <div
        className={styles.fileTreeBody}
        onMouseOver={handleBodyMouseOver}
        onMouseLeave={handleBodyMouseLeave}
      >
        {/* #513 — fixed comment rail. First child of the body, OUTSIDE .fileTreeScroll
            (like the AI/check columns on the right) so it never rides off on horizontal
            scroll. Rendered from the same flat `rows` list so row i lines up across all
            four columns. Collapses to width 0 when the PR has no threads (data-has-comments
            on the root). aria-hidden — the spoken signal lives on the row (Task 4). */}
        <div className={`file-tree-comment-col ${styles.fileTreeCommentCol}`} aria-hidden="true">
          {rows.map((row) =>
            row.kind === 'file' ? (
              <CommentSlot
                key={row.key}
                path={row.node.path}
                state={commentStateByPath?.get(row.node.path) ?? null}
                counts={commentCountsByPath?.get(row.node.path) ?? null}
                selected={row.node.path === selectedPath}
                hovered={hoveredPath === row.node.path}
              />
            ) : (
              <div
                key={row.key}
                className={styles.fileTreeCommentSlot}
                data-row-key={row.dirKey}
                data-row-hovered={hoveredPath === row.dirKey ? 'true' : undefined}
              />
            ),
          )}
        </div>
        <div
          ref={scrollRef}
          className={`file-tree-scroll ${styles.fileTreeScroll}`}
          role="tree"
          aria-label="File tree"
          onKeyDown={handleTreeKeyDown}
        >
          <div className={`file-tree-inner ${styles.fileTreeInner}`}>
            {rows.map((row) =>
              row.kind === 'dir' ? (
                <DirCell
                  key={row.key}
                  row={row}
                  onToggle={toggleDir}
                  isHovered={hoveredPath === row.dirKey}
                  isFocusStop={row.key === effectiveFocusedKey}
                  onRowFocus={handleRowFocus}
                  setRowEl={setRowEl}
                />
              ) : (
                <FileCell
                  key={row.key}
                  row={row}
                  isSelected={selectedPath === row.node.path}
                  isViewed={viewedPaths.has(row.node.path)}
                  isHovered={hoveredPath === row.node.path}
                  onSelectFile={onSelectFile}
                  focusLevel={focusByPath?.get(row.node.path) ?? null}
                  commentState={commentStateByPath?.get(row.node.path) ?? null}
                  isFocusStop={row.key === effectiveFocusedKey}
                  onRowFocus={handleRowFocus}
                  setRowEl={setRowEl}
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
                path={row.node.path}
                selected={row.node.path === selectedPath}
                hovered={hoveredPath === row.node.path}
              />
            ) : (
              <div
                key={row.key}
                className={styles.fileTreeAiSlot}
                data-row-key={row.dirKey}
                data-row-hovered={hoveredPath === row.dirKey ? 'true' : undefined}
              />
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
                selected={row.node.path === selectedPath}
                hovered={hoveredPath === row.node.path}
              />
            ) : (
              <div
                key={row.key}
                className={styles.fileTreeCheckSlot}
                aria-hidden="true"
                data-row-key={row.dirKey}
                data-row-hovered={hoveredPath === row.dirKey ? 'true' : undefined}
              />
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
        {/* #513 — leading spacer mirrors the comment rail so the synthetic bar stays
            aligned under .fileTreeScroll once the tree is shifted right by the rail.
            Collapses to 0 in lockstep with the rail (same data-has-comments gate). */}
        <div className={styles.fileTreeHScrollSpacerColLead} />
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
  isHovered,
  onSelectFile,
  focusLevel,
  commentState,
  isFocusStop,
  onRowFocus,
  setRowEl,
}: {
  row: FileRow;
  isSelected: boolean;
  isViewed: boolean;
  isHovered: boolean;
  onSelectFile: (path: string) => void;
  focusLevel: FocusLevel | null;
  commentState: CommentIndicatorState | null;
  isFocusStop: boolean;
  onRowFocus: (key: string) => void;
  setRowEl: (key: string, el: HTMLElement | null) => void;
}) {
  const node = row.node;
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Stable identity so React does not detach/reattach every row's ref on every
  // FileTree re-render (hover state changes re-render all cells).
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      setRowEl(row.key, el);
    },
    [setRowEl, row.key],
  );
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
      data-row-path={node.path}
      data-row-selected={isSelected ? 'true' : undefined}
      data-row-hovered={isHovered ? 'true' : undefined}
      style={{ paddingLeft: `${(row.depth + 1) * INDENT_PER_LEVEL}px` }}
      // Focus is granted HERE with preventScroll instead of by the browser's native
      // click-to-focus (suppressed via onMouseDown), which can write scrollLeft on the
      // clipped viewport (#214 desync) and does not fire at all in every engine.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        rowRef.current?.focus({ preventScroll: true });
        onSelectFile(node.path);
      }}
      onFocus={() => onRowFocus(row.key)}
      tabIndex={isFocusStop ? 0 : -1}
      ref={setRef}
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
      {/* #513 — comment state in reading order (status word → name → AI focus →
          comment state). Carries the resolved/unresolved distinction non-visually
          so the accent-dim glyph is not a colour-only signal (WCAG 1.4.1). */}
      {commentState === 'unresolved' && <span className="sr-only"> has unresolved comments</span>}
      {commentState === 'resolved' && <span className="sr-only"> comments resolved</span>}
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
function AiSlot({
  focusLevel,
  aiPreview,
  path,
  selected,
  hovered,
}: {
  focusLevel: FocusLevel | null;
  aiPreview: boolean;
  path: string;
  selected: boolean;
  hovered: boolean;
}) {
  return (
    <div
      className={styles.fileTreeAiSlot}
      data-row-path={path}
      data-row-selected={selected ? 'true' : undefined}
      data-row-hovered={hovered ? 'true' : undefined}
    >
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

// #513 — one slot per file row in the fixed comment rail. `none` ⇒ empty slot (glyph
// suppressed); the state class sets the accent colour the glyph inherits via currentColor.
// data-row-path is the hover/selected resolution key (Task 5) — present on EVERY column's
// per-row slot so a pointer anywhere on the row resolves to it.
function CommentSlot({
  path,
  state,
  counts,
  selected,
  hovered,
}: {
  path: string;
  state: CommentIndicatorState | null;
  counts: CommentCounts | null;
  selected: boolean;
  hovered: boolean;
}) {
  const stateClass =
    state === 'unresolved'
      ? styles.fileTreeCommentSlotUnresolved
      : state === 'resolved'
        ? styles.fileTreeCommentSlotResolved
        : '';
  return (
    <div
      className={`${styles.fileTreeCommentSlot}${stateClass ? ` ${stateClass}` : ''}`}
      data-row-path={path}
      data-comment-state={state ?? 'none'}
      // #513 — hover tooltip carries the thread counts the count-free glyph omits.
      // The rail is aria-hidden, so this is a pointer-only affordance (the row's
      // sr-only text already speaks the state); mirrors the AI dot's own `title`.
      title={counts ? commentTooltip(counts) : undefined}
      data-row-selected={selected ? 'true' : undefined}
      data-row-hovered={hovered ? 'true' : undefined}
    >
      {state && <CommentGlyph variant={state === 'resolved' ? 'resolved' : 'filled'} />}
    </div>
  );
}

function CheckSlot({
  node,
  isViewed,
  onToggleViewed,
  selected,
  hovered,
}: {
  node: FileTreeNode;
  isViewed: boolean;
  onToggleViewed: (path: string) => void;
  selected: boolean;
  hovered: boolean;
}) {
  // onChange (not onClick + readOnly) so Space-key activation toggles consistently
  // across browsers. The checkbox lives in its own column, so no row-level click to
  // stop from bubbling.
  const handleChange = useCallback(() => {
    onToggleViewed(node.path);
  }, [onToggleViewed, node.path]);

  return (
    <div
      className={styles.fileTreeCheckSlot}
      data-row-path={node.path}
      data-row-selected={selected ? 'true' : undefined}
      data-row-hovered={hovered ? 'true' : undefined}
    >
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

function DirCell({
  row,
  onToggle,
  isHovered,
  isFocusStop,
  onRowFocus,
  setRowEl,
}: {
  row: DirRow;
  onToggle: (dirKey: string) => void;
  isHovered: boolean;
  isFocusStop: boolean;
  onRowFocus: (key: string) => void;
  setRowEl: (key: string, el: HTMLElement | null) => void;
}) {
  const node = row.node;
  const { expanded } = row;
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Stable identity so React does not detach/reattach every row's ref on every
  // FileTree re-render (hover state changes re-render all cells).
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      setRowEl(row.key, el);
    },
    [setRowEl, row.key],
  );
  return (
    <div
      className={`file-tree-dir-header ${styles.fileTreeDirHeader}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={expanded}
      // #200 — without this the row's accessible name would concatenate the (now
      // aria-hidden) chevron's text with the visible name span; the dir treeitem must
      // announce its name exactly once.
      aria-label={node.name}
      data-row-key={row.dirKey}
      data-row-hovered={isHovered ? 'true' : undefined}
      style={{ paddingLeft: `${row.depth * INDENT_PER_LEVEL}px` }}
      // The click handler lives on the treeitem ROW (chevron clicks bubble here), so
      // AT-synthesized clicks on the treeitem activate directories too, and the explicit
      // focus keeps real DOM focus on a visible treeitem in every engine — clicking the
      // chevron must never park focus on an aria-hidden node, and collapsing via mouse
      // must not strand focus on a row about to unmount. Focus from a user gesture only;
      // native mousedown focusing is suppressed (it ignores preventScroll → #214 desync).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        rowRef.current?.focus({ preventScroll: true });
        onToggle(row.dirKey);
      }}
      onFocus={() => onRowFocus(row.key)}
      tabIndex={isFocusStop ? 0 : -1}
      ref={setRef}
    >
      {/* #200 — pointer-only decoration: the row treeitem is the keyboard AND click
          surface (its onClick above handles the bubbled chevron click), so the chevron
          leaves the tab order and the accessibility tree, never takes focus itself
          (mousedown default suppressed), and the row's aria-expanded carries the state. */}
      <button
        type="button"
        className={`file-tree-dir-toggle ${styles.fileTreeDirToggle}`}
        onMouseDown={(e) => e.preventDefault()}
        tabIndex={-1}
        aria-hidden="true"
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
