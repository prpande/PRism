import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileChange,
  ReviewThreadDto,
  DraftSide,
  PrReference,
  HunkAnnotation,
  DiffLine,
} from '../../../../api/types';
import { parseHunkLines, interleaveWholeFile } from './interleaveWholeFile';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import {
  ExistingCommentWidget,
  type ExistingCommentWidgetReplyContext,
  type ThreadCollapseControl,
} from './ExistingCommentWidget';
import { DiffTruncationBanner } from './DiffTruncationBanner';
import { WordDiffOverlay } from './WordDiffOverlay';
import { AiHunkAnnotation } from './AiHunkAnnotation';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';
import { useLockedPaneScroll } from '../../../../hooks/useLockedPaneScroll';
import { useDiffViewportWidthVar } from '../../../../hooks/useDiffViewportWidthVar';
import {
  useSyntaxTokens,
  normalizeEol,
  type SyntaxTokenMaps,
} from '../../../../hooks/useSyntaxTokens';
import { HighlightedLine } from '../../../Markdown/HighlightedLine';
import { type LineToken, pathToLang } from '../../../Markdown/shikiInstance';
import { mergeWordDiffWithTokens } from './mergeWordDiff';
import { diffWordsWithSpace } from 'diff';
import { WholeFileFailureBanner } from './WholeFileFailureBanner';
import { Spinner } from '../../../Spinner';
import { computeChanges } from '../DiffChangeNav/diffChanges';
import { useChangeNavigation } from '../DiffChangeNav/useChangeNavigation';
import { ChangeNavControls } from '../DiffChangeNav/ChangeNavControls';
import { ChangeMinimap } from '../DiffChangeNav/ChangeMinimap';
import { isInputTarget } from '../../../../hooks/isInputTarget';
import styles from './DiffPane.module.css';

export type DiffMode = 'side-by-side' | 'unified';

// Look up the syntax tokens for a single diff line, keyed by 1-based line
// number on the requested side. Returns [] when the line has no number on
// that side (e.g. a delete line has no new-side number) or the map has no
// entry — HighlightedLine then renders its plaintext fallback.
function tokensFor(
  maps: SyntaxTokenMaps,
  side: 'old' | 'new',
  lineNum: number | null | undefined,
): LineToken[] {
  if (lineNum == null) return [];
  return (side === 'old' ? maps.oldLineTokens : maps.newLineTokens).get(lineNum) ?? [];
}

// Renders one side of a paired (modified) line: shiki syntax color layered with
// background-only word-diff. When tokens are not yet available (highlighter
// warming, or large-file suppression), falls back to the legacy WordDiffOverlay
// so the changed-region emphasis never regresses to plaintext.
function MergedPairedContent({
  syntax,
  side,
  lineNum,
  oldText,
  newText,
}: {
  syntax: SyntaxTokenMaps;
  side: 'old' | 'new';
  lineNum: number | null | undefined;
  oldText: string;
  newText: string;
}) {
  const toks = tokensFor(syntax, side, lineNum);
  if (toks.length === 0) {
    // No tokens yet (highlighter warming / large file) → existing word-diff fallback.
    return (
      <WordDiffOverlay
        oldText={oldText}
        newText={newText}
        type={side === 'old' ? 'delete' : 'insert'}
      />
    );
  }
  // sideText is the token concatenation, NOT pair.content — guarantees
  // sum(token.length) === sideText.length so the merge's index walk is always in-bounds.
  const sideText = toks.map((t) => t.text).join('');
  // Defense-in-depth: the word-diff indexes sideText's coordinate space, so the
  // tokens for this line MUST equal this side's content. In whole-file mode a
  // line-number/blob disagreement would silently mis-highlight; fall back to the
  // always-correct overlay instead.
  const expected = normalizeEol(side === 'old' ? oldText : newText);
  if (sideText !== expected) {
    return (
      <WordDiffOverlay
        oldText={oldText}
        newText={newText}
        type={side === 'old' ? 'delete' : 'insert'}
      />
    );
  }
  // PERF (PoC-deferred): diffWordsWithSpace runs once per paired line per render
  // (e.g. on theme toggle). Paired lines are a small subset, so this is fine at
  // PoC scale; if large modify-heavy diffs become a hot path, memoize parts /
  // wrap MergedPairedContent in React.memo. Tracked as a future optimization.
  const parts = diffWordsWithSpace(normalizeEol(oldText), normalizeEol(newText));
  const spans = mergeWordDiffWithTokens(sideText, toks, parts, side);
  return <HighlightedLine spans={spans} fallback={sideText} />;
}

export interface DiffPaneProps {
  prRef: PrReference;
  selectedPath: string | null;
  file: FileChange | null;
  diffMode: DiffMode;
  truncated: boolean;
  reviewThreads: ReviewThreadDto[];
  prUrl?: string;
  // Spec § 5.3a: clicking an "Add comment" affordance on a diff line opens
  // an InlineCommentComposer at that line. The handler is owned by FilesTab
  // because the composer's lifecycle (and the A2 click-another-line modal)
  // is sibling-state to the diff view.
  onLineClick?: (anchor: InlineAnchor) => void;
  // Optional renderer for an inline composer mounted on the clicked line.
  // FilesTab passes its <InlineCommentComposer> here; DiffPane simply
  // inserts it as a full-width follow-up row analogous to ExistingCommentWidget.
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  // Bound by FilesTab from its `useDraftSession`. Forwarded verbatim to each
  // `<ExistingCommentWidget>` so per-thread Reply buttons can mount a
  // `<ReplyComposer>`. Absent → DiffPane test harnesses render threads
  // read-only.
  replyContext?: ExistingCommentWidgetReplyContext;
  // Collapse controller for review threads. Forwarded verbatim to each
  // `<ExistingCommentWidget>`. Absent → all threads render expanded (default).
  collapse?: ThreadCollapseControl;
  // D36 / #125 — when true, renders a <Spinner> in the diff-pane header. A real
  // element with an sr-only label (not CSS ::after) so screen readers announce
  // it (WCAG 2.1 F87).
  isLoading?: boolean;

  // Slice 2 additions (all optional with defaults — see destructuring below):
  wholeFileEnabled?: boolean;
  onWholeFileFailed?: (reason: string) => void;
  // #510: re-attempt the whole-file fetch from the failure banner (FilesTab drops
  // this file from its failed set so deriveWholeFileEnabled re-permits it). Absent
  // → the banner shows only Dismiss.
  onWholeFileRetry?: () => void;
  headSha?: string;
  baseSha?: string;

  // #115 — when true, long diff lines soft-wrap within their pane instead of
  // scrolling. Default (false) = scroll: a single synthetic scrollbar
  // (`diffHScroll`) shifts all split-mode content cells in lockstep via
  // useLockedPaneScroll, so a too-wide line scrolls without the two panes
  // drifting out of column-alignment. Owned by FilesTab's toolbar toggle.
  lineWrap?: boolean;

  // #508 (B1) — resolved hunk annotations for the whole PR, lifted to FilesTab (the
  // single fetch source) so the file-tree header marker can also reflect the
  // annotation-loading state. DiffPane just renders the ones for the open file; it no
  // longer owns the fetch or any per-hunk loading skeleton (a positional skeleton
  // over-promised — focus level ≠ which hunks the annotator actually annotates). null
  // when AI is off, still loading, or the annotator returned nothing.
  annotations?: HunkAnnotation[] | null;
}

// New-side gutter cell. #554: the line number is ALWAYS rendered as visible flow
// text; the comment affordance is an additive hover glyph (a filled, accent-colored
// comment bubble; its aria-label carries the line number, so the click contract
// that many e2e specs query by `name: /add comment on line N/` is unchanged).
// Previously the number lived *inside* the opacity-0 affordance button, so on
// all-insert (added) files — which have no old-side number — the entire gutter
// looked blank until hover.
function NewGutterCell({
  lineNum,
  onComment,
}: {
  lineNum: number | null | undefined;
  onComment?: () => void;
}) {
  return (
    <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
      <span className={`diff-gutter-num ${styles.diffGutterNum}`}>{lineNum ?? ''}</span>
      {lineNum != null && onComment && (
        <button
          type="button"
          className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
          aria-label={`Add comment on line ${lineNum}`}
          onClick={onComment}
        >
          {/* Filled Octicon comment-16 (solid bubble), accent-colored via CSS.
              The aria-label carries the accessible name, so the glyph is hidden. */}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1Z" />
          </svg>
        </button>
      )}
    </td>
  );
}

function findAdjacentPair(lines: DiffLine[], idx: number): DiffLine | null {
  const line = lines[idx];
  if (line.type === 'delete') {
    const next = lines[idx + 1];
    if (next?.type === 'insert') return next;
  }
  if (line.type === 'insert') {
    const prev = lines[idx - 1];
    if (prev?.type === 'delete') return prev;
  }
  return null;
}

export function DiffPane({
  prRef,
  selectedPath,
  file,
  diffMode,
  truncated,
  reviewThreads,
  prUrl,
  onLineClick,
  renderComposerForLine,
  replyContext,
  collapse,
  isLoading = false,
  wholeFileEnabled = false,
  onWholeFileFailed,
  onWholeFileRetry,
  headSha = '',
  baseSha = '',
  lineWrap = false,
  annotations = null,
}: DiffPaneProps) {
  const annotationsForFile = useMemo(() => {
    if (!annotations || !selectedPath) return null;
    const m = new Map<number, HunkAnnotation[]>();
    for (const a of annotations) {
      if (a.path !== selectedPath) continue;
      const existing = m.get(a.hunkIndex);
      if (existing) existing.push(a);
      else m.set(a.hunkIndex, [a]);
    }
    return m;
  }, [annotations, selectedPath]);

  // Hook ordering rule: isSplit must be computed before the hook call so it
  // can be passed as a parameter.
  const isSplit = diffMode === 'side-by-side';

  const wholeFile = useWholeFileContent({
    prRef,
    path: selectedPath,
    file,
    headSha,
    baseSha,
    enabled: wholeFileEnabled,
    isSplit,
  });

  const syntax = useSyntaxTokens({
    path: selectedPath,
    file,
    wholeFileEnabled,
    wholeFile,
    isSplit,
    headSha,
    baseSha,
  });

  // Failure latch: fires onWholeFileFailed once per transition to 'failed'.
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const prevStatus = useRef<typeof wholeFile.fetchStatus>('idle');

  useEffect(() => {
    if (
      prevStatus.current !== 'failed' &&
      wholeFile.fetchStatus === 'failed' &&
      wholeFile.failureReason
    ) {
      setLocalFailure(wholeFile.failureReason);
      onWholeFileFailed?.(wholeFile.failureReason);
    }
    prevStatus.current = wholeFile.fetchStatus;
  }, [wholeFile.fetchStatus, wholeFile.failureReason, onWholeFileFailed]);

  // Clear the latch on file navigation. The banner is scoped to the file
  // that produced the failure; carrying its reason across a file switch
  // shows a misleading banner for the new file (Copilot iter-1 finding).
  // Skip the initial mount — the latch detection effect above can set
  // the latch on the same render that this effect's deps initialize,
  // and React batches both setStates; without the skip, the clear
  // would land last and clobber the latch.
  const isInitialPathMount = useRef(true);
  useEffect(() => {
    if (isInitialPathMount.current) {
      isInitialPathMount.current = false;
      return;
    }
    setLocalFailure(null);
  }, [selectedPath]);

  // Dismiss only clears the latch — the toggle-revert callback already
  // fired on the original failure transition (above). Calling onWholeFileFailed
  // here would re-fire against the CURRENT selectedPath, which may be a
  // different file than the one that produced the failure (Copilot iter-1
  // navigation race).
  const dismissBanner = () => {
    setLocalFailure(null);
  };

  // #510: in-place retry. Clear the local latch (hides the banner immediately) and
  // ask FilesTab to re-permit whole-file view for this file, which re-fires the
  // fetch (failed results are never cached). A re-failure simply re-latches.
  const retryWholeFile = onWholeFileRetry
    ? () => {
        setLocalFailure(null);
        onWholeFileRetry();
      }
    : undefined;

  // allLines: whole-file branch takes over when enabled + ok; else plain hunk
  // parsing.
  const allLines: DiffLine[] = useMemo(() => {
    if (!file) return [];
    if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && wholeFile.headContent !== null) {
      return interleaveWholeFile(file, wholeFile.headContent, wholeFile.baseContent);
    }
    const out: DiffLine[] = [];
    for (const hunk of file.hunks) {
      out.push(...parseHunkLines(hunk.body));
    }
    return out;
  }, [file, wholeFileEnabled, wholeFile.fetchStatus, wholeFile.headContent, wholeFile.baseContent]);

  // #554: gutter width tracks the widest line number in the file so 3-4 digit
  // numbers aren't clipped. Exposed as a CSS var consumed by --diff-gutter-w
  // (DiffPane.module.css). Floor of 2 keeps a stable minimum gutter width.
  const gutterDigits = useMemo(() => {
    let max = 0;
    for (const l of allLines) {
      if (l.oldLineNum && l.oldLineNum > max) max = l.oldLineNum;
      if (l.newLineNum && l.newLineNum > max) max = l.newLineNum;
    }
    return Math.max(2, String(max).length);
  }, [allLines]);

  // AI annotation re-anchoring map for whole-file mode: maps row idx → annotations
  // that should render before that row (first non-header line after each hunk-header).
  const annotationsByRowIdx = useMemo(() => {
    if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') return null;
    const map = new Map<number, HunkAnnotation[]>();
    const consumedHunks = new Set<number>();
    let hunkCounter = -1;
    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];
      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        continue;
      }
      if (hunkCounter >= 0 && !consumedHunks.has(hunkCounter)) {
        const ann = annotationsForFile?.get(hunkCounter);
        if (ann) map.set(idx, ann);
        consumedHunks.add(hunkCounter);
      }
    }
    return map;
  }, [wholeFileEnabled, wholeFile.fetchStatus, allLines, annotationsForFile]);

  // Scroll reset on wholeFileEnabled toggle or file navigation.
  const diffBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (diffBodyRef.current) diffBodyRef.current.scrollTop = 0;
  }, [wholeFileEnabled, selectedPath]);

  // #115 — locked side-by-side horizontal scroll. Active only in split
  // scroll-mode (not wrap, not unified): a single synthetic scrollbar drives
  // both content panes' scrollLeft in lockstep so old/new of the same line stay
  // column-aligned. Re-measures when the rendered diff content changes.
  const hScrollRef = useRef<HTMLDivElement>(null);
  const hScrollSpacerRef = useRef<HTMLDivElement>(null);
  const lockedScrollEnabled = isSplit && !lineWrap;
  useLockedPaneScroll(diffBodyRef, hScrollRef, hScrollSpacerRef, lockedScrollEnabled, [
    selectedPath,
    wholeFileEnabled,
    allLines.length,
  ]);
  // #390 — keep --diff-viewport-w in sync with the visible diff width so the
  // sticky comment/composer wrapper pins to the viewport, not the over-wide
  // table. Re-measures on file/mode/wrap AND content-height changes (a vertical
  // scrollbar appearing shrinks clientWidth — a ResizeObserver blind spot).
  useDiffViewportWidthVar(diffBodyRef, [
    selectedPath,
    isSplit,
    lineWrap,
    wholeFileEnabled,
    allLines.length,
  ]);

  const tableRef = useRef<HTMLTableElement>(null);
  const changes = useMemo(() => computeChanges(allLines), [allLines]);
  // The change-nav index resets to the top only when the rendered view actually
  // swaps — keyed on the same view identity the scroll-reset above uses
  // (selectedPath + the DERIVED whole-file mode, line ~372) — so the two stay in
  // lockstep and a same-file `changes` recompute (whole-file success / parent
  // re-fetch) doesn't snap the counter back to "1" (#577). The `\n` separator is
  // collision-proof: a newline can't appear in a file path, so no path+flag pair
  // aliases another. `wholeFileEnabled` is the derived mode (off on a fetch
  // failure), so a failure flips it and resets — in lockstep with the scroll-reset.
  const navResetKey = `${selectedPath ?? ''}\n${wholeFileEnabled}`;
  const nav = useChangeNavigation(diffBodyRef, tableRef, changes, navResetKey);

  // Boundary maps: allLines index -> change index, for the run's first and last rows.
  const { changeStartMap, changeEndMap } = useMemo(() => {
    const start = new Map<number, number>();
    const end = new Map<number, number>();
    changes.forEach((c, i) => {
      start.set(c.startRowIdx, i);
      end.set(c.endRowIdx, i);
    });
    return { changeStartMap: start, changeEndMap: end };
  }, [changes]);

  // n/p keyboard: register ONCE per mount; read the latest handlers through a ref
  // (mirrors useFilesTabShortcuts — avoids re-subscribing the document listener on
  // every scroll-driven render). Visibility guard: keep-alive keeps other PR tabs and
  // the non-Files subtab mounted but display:none (PrDetailView hidden={subTab!=='files'},
  // PrTabHost inactive views), so a hidden pane's diffBodyRef has offsetParent === null —
  // skip it so hidden diffs never scroll or SR-announce.
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'n' && e.key !== 'p') return;
      if (isInputTarget(e.target)) return;
      if (!diffBodyRef.current || diffBodyRef.current.offsetParent === null) return;
      if (e.key === 'n') navRef.current.goToNext();
      else navRef.current.goToPrev();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ---- Early-return guards (all hooks must be above here) ----

  if (!selectedPath) {
    return (
      <div
        className={`diff-pane diff-pane--empty ${styles.diffPane} ${styles.diffPaneEmpty}`}
        data-testid="diff-pane"
      >
        <p className="muted">Select a file from the tree to view its diff.</p>
      </div>
    );
  }

  // Loading-state branch — intercept in-flight fetches before the empty-file
  // branch fires. Without this, a `file === null` mid-fetch falsely renders
  // "Empty file — no changes to display." (Copilot iter 1 #1).
  if (isLoading && !file) {
    return (
      <div className={`diff-pane ${styles.diffPane}`} data-testid="diff-pane">
        <div className={`diff-pane-header ${styles.diffPaneHeader}`} data-testid="diff-pane-header">
          <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
          <Spinner size="sm" className={styles.diffPaneLoading} />
        </div>
      </div>
    );
  }

  if (!file || file.hunks.length === 0) {
    return (
      <div className={`diff-pane ${styles.diffPane}`} data-testid="diff-pane">
        <div className={`diff-pane-header ${styles.diffPaneHeader}`} data-testid="diff-pane-header">
          <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
        </div>
        <div className={`diff-pane-body muted ${styles.diffPaneBody}`}>
          Empty file — no changes to display.
        </div>
      </div>
    );
  }

  const fileThreads = reviewThreads.filter((t) => t.filePath === selectedPath);
  const threadsByLine = new Map<number, ReviewThreadDto[]>();
  for (const t of fileThreads) {
    const existing = threadsByLine.get(t.lineNumber) ?? [];
    existing.push(t);
    threadsByLine.set(t.lineNumber, existing);
  }

  const colSpan = isSplit ? 4 : 3;
  const modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified';
  const wrapClass = lineWrap ? ' diff-pane--wrap' : '';

  // The minimap renders only in whole-file mode when the content overflows and
  // has changes. The native vertical scrollbar is hidden under exactly the same
  // condition — never hide it without the rail there to replace it.
  const showMinimap =
    wholeFileEnabled && wholeFile.fetchStatus === 'ok' && nav.hasOverflow && changes.length > 0;

  // Large-file indicator: when the file is a highlightable language and has
  // hunks, but the syntax hook produced no tokens, highlighting was suppressed
  // (over the large-file budget). Gated on syntax.ready, which only flips true
  // after the highlighter has warmed up, so this never shows during warm-up —
  // an empty token map with ready === true means the size guard genuinely fired.
  const highlightSuppressed =
    syntax.ready &&
    selectedPath != null &&
    pathToLang(selectedPath) !== null &&
    file != null &&
    file.hunks.length > 0 &&
    syntax.oldLineTokens.size === 0 &&
    syntax.newLineTokens.size === 0;

  function renderDiffRows(): React.ReactNode[] {
    if (isSplit) return renderSplitRows();
    return renderUnifiedRows();
  }

  function renderUnifiedRows(): React.ReactNode[] {
    const path = selectedPath ?? '';
    const rows: React.ReactNode[] = [];
    let hunkCounter = -1;
    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];

      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') {
          // Hunks-only mode: emit the hunk-header row + per-hunk AI annotations.
          const commentLineNum = line.newLineNum;
          const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
          const pair = findAdjacentPair(allLines, idx);
          rows.push(
            <DiffLineRow
              key={idx}
              line={line}
              pair={pair}
              threadsAtLine={threadsAtLine}
              filePath={path}
              colSpan={colSpan}
              syntax={syntax}
              onLineClick={onLineClick}
              renderComposerForLine={renderComposerForLine}
              replyContext={replyContext}
              collapse={collapse}
            />,
          );
          const annotations = annotationsForFile?.get(hunkCounter);
          if (annotations) {
            for (let aidx = 0; aidx < annotations.length; aidx++) {
              rows.push(
                <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                  <td colSpan={colSpan}>
                    <AiHunkAnnotation annotation={annotations[aidx]} />
                  </td>
                </tr>,
              );
            }
          }
        }
        // Whole-file ok mode: emit nothing for the hunk-header itself.
        continue;
      }

      // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
      if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && annotationsByRowIdx) {
        const ann = annotationsByRowIdx.get(idx);
        if (ann) {
          for (let aidx = 0; aidx < ann.length; aidx++) {
            rows.push(
              <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                <td colSpan={colSpan}>
                  <AiHunkAnnotation annotation={ann[aidx]} />
                </td>
              </tr>,
            );
          }
        }
      }

      const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
      const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
      const pair = findAdjacentPair(allLines, idx);

      rows.push(
        <DiffLineRow
          key={idx}
          line={line}
          pair={pair}
          threadsAtLine={threadsAtLine}
          filePath={path}
          colSpan={colSpan}
          syntax={syntax}
          isFilled={line.isFilled}
          dataChangeStart={changeStartMap.get(idx)}
          dataChangeEnd={changeEndMap.get(idx)}
          onLineClick={onLineClick}
          renderComposerForLine={renderComposerForLine}
          replyContext={replyContext}
          collapse={collapse}
        />,
      );
    }
    return rows;
  }

  function renderSplitRows(): React.ReactNode[] {
    const path = selectedPath ?? '';
    const rows: React.ReactNode[] = [];
    let hunkCounter = -1;

    // Inline helper — emits an ExistingCommentWidget row (if threadsByLine has
    // entries for the right-side line number) followed by a composer-slot row
    // (if renderComposerForLine returns non-null). Both use the mode-aware
    // colSpan. Solo-delete and hunk-header rows do NOT call this helper — they
    // have no right-side line number to anchor to, consistent with
    // unified-mode behavior.
    function emitWidgetAndComposerRows(idx: number, anchorLineNum: number | null): void {
      if (anchorLineNum == null) return;
      const threads = threadsByLine.get(anchorLineNum);
      if (threads && threads.length > 0) {
        rows.push(
          <tr key={`widget-${idx}`} className={`diff-comment-row ${styles.diffCommentRow}`}>
            <td colSpan={colSpan}>
              <div className={styles.diffStickyViewport}>
                <ExistingCommentWidget
                  threads={threads}
                  replyContext={replyContext}
                  collapse={collapse}
                />
              </div>
            </td>
          </tr>,
        );
      }
      if (renderComposerForLine) {
        const node = renderComposerForLine(path, anchorLineNum);
        if (node) {
          rows.push(
            <tr key={`composer-${idx}`} className={`diff-composer-row ${styles.diffComposerRow}`}>
              <td colSpan={colSpan}>
                <div className={styles.diffStickyViewport}>{node}</div>
              </td>
            </tr>,
          );
        }
      }
    }

    for (let idx = 0; idx < allLines.length; idx++) {
      const line = allLines[idx];

      if (line.type === 'hunk-header') {
        hunkCounter += 1;
        if (!wholeFileEnabled || wholeFile.fetchStatus !== 'ok') {
          rows.push(
            <SplitDiffLineRow
              key={idx}
              kind="header"
              content={line.content}
              filePath={path}
              syntax={syntax}
            />,
          );
          const annotations = annotationsForFile?.get(hunkCounter);
          if (annotations) {
            for (let aidx = 0; aidx < annotations.length; aidx++) {
              rows.push(
                <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                  <td colSpan={colSpan}>
                    <AiHunkAnnotation annotation={annotations[aidx]} />
                  </td>
                </tr>,
              );
            }
          }
        }
        continue;
      }

      // Whole-file ok mode: emit pre-line annotations queued in annotationsByRowIdx.
      if (wholeFileEnabled && wholeFile.fetchStatus === 'ok' && annotationsByRowIdx) {
        const ann = annotationsByRowIdx.get(idx);
        if (ann) {
          for (let aidx = 0; aidx < ann.length; aidx++) {
            rows.push(
              <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                <td colSpan={colSpan}>
                  <AiHunkAnnotation annotation={ann[aidx]} />
                </td>
              </tr>,
            );
          }
        }
      }

      if (line.type === 'context') {
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="context"
            oldLineNum={line.oldLineNum}
            newLineNum={line.newLineNum}
            content={line.content}
            filePath={path}
            syntax={syntax}
            isFilled={line.isFilled}
            isAnchored={!!threadsByLine.get(line.newLineNum ?? -1)?.length}
            onLineClick={onLineClick}
          />,
        );
        emitWidgetAndComposerRows(idx, line.newLineNum);
        continue;
      }

      if (line.type === 'delete') {
        const next = allLines[idx + 1];
        if (next?.type === 'insert') {
          rows.push(
            <SplitDiffLineRow
              key={idx}
              kind="paired"
              oldLineNum={line.oldLineNum}
              newLineNum={next.newLineNum}
              oldText={line.content}
              newText={next.content}
              filePath={path}
              syntax={syntax}
              isAnchored={!!threadsByLine.get(next.newLineNum ?? -1)?.length}
              dataChangeStart={changeStartMap.get(idx) ?? changeStartMap.get(idx + 1)}
              dataChangeEnd={changeEndMap.get(idx) ?? changeEndMap.get(idx + 1)}
              onLineClick={onLineClick}
            />,
          );
          emitWidgetAndComposerRows(idx, next.newLineNum);
          idx += 1; // consume the paired insert; the for-loop's ++ advances past it
          continue;
        }
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="solo-delete"
            oldLineNum={line.oldLineNum}
            content={line.content}
            filePath={path}
            syntax={syntax}
            dataChangeStart={changeStartMap.get(idx)}
            dataChangeEnd={changeEndMap.get(idx)}
          />,
        );
        continue;
      }

      if (line.type === 'insert') {
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="solo-insert"
            newLineNum={line.newLineNum}
            content={line.content}
            filePath={path}
            syntax={syntax}
            isAnchored={!!threadsByLine.get(line.newLineNum ?? -1)?.length}
            dataChangeStart={changeStartMap.get(idx)}
            dataChangeEnd={changeEndMap.get(idx)}
            onLineClick={onLineClick}
          />,
        );
        emitWidgetAndComposerRows(idx, line.newLineNum);
        continue;
      }
    }
    return rows;
  }

  return (
    <div
      className={`diff-pane ${modeClass}${wrapClass} ${styles.diffPane}`}
      data-testid="diff-pane"
      style={{ '--diff-gutter-digits': gutterDigits } as React.CSSProperties}
    >
      <div className={`diff-pane-header ${styles.diffPaneHeader}`} data-testid="diff-pane-header">
        <span className={`diff-pane-path ${styles.diffPanePath}`}>{selectedPath}</span>
        {/* Suppress the change-nav controls (which carry their own role=status
            announce region) while the whole-file overlay spinner is loading, so
            only one live region announces at a time — same single-live-region
            invariant that gates the header spinner below (#450). Offsets aren't
            measured mid-load anyway; the controls reappear once content is ok. */}
        {changes.length > 0 && !(wholeFileEnabled && wholeFile.fetchStatus === 'loading') && (
          <ChangeNavControls
            total={nav.total}
            currentIdx={nav.currentIdx}
            canPrev={nav.canPrev}
            canNext={nav.canNext}
            onPrev={nav.goToPrev}
            onNext={nav.goToNext}
          />
        )}
        {/* Suppress the header spinner while the whole-file overlay spinner is
            active so only one role=status live region announces at a time. */}
        {isLoading && !(wholeFileEnabled && wholeFile.fetchStatus === 'loading') && (
          <Spinner size="sm" className={styles.diffPaneLoading} />
        )}
        {!isLoading && highlightSuppressed && (
          <span className={`diff-pane-loading muted ${styles.diffPaneLoading}`}>
            Syntax highlighting off (large file)
          </span>
        )}
      </div>
      {localFailure !== null && (
        <WholeFileFailureBanner
          reason={localFailure}
          onDismiss={dismissBanner}
          onRetry={retryWholeFile}
        />
      )}
      <div className={styles.diffBodyWrap}>
        <div
          ref={diffBodyRef}
          className={`diff-pane-body ${styles.diffPaneBody} ${
            wholeFileEnabled && wholeFile.fetchStatus === 'loading'
              ? styles.diffPaneBodyLoading
              : ''
          } ${showMinimap ? styles.diffPaneBodyNoScrollbar : ''}`}
        >
          {wholeFileEnabled && wholeFile.fetchStatus === 'loading' && (
            <div className={styles.diffPaneLoadingOverlay}>
              <Spinner size="md" label="Loading whole file…" />
            </div>
          )}
          <table ref={tableRef} className={`diff-table ${styles.diffTable}`}>
            {isSplit && (
              <colgroup>
                {/* #554: gutter columns size from --diff-gutter-w (digit-count
                    derived) so wide line numbers aren't clipped in fixed layout. */}
                <col style={{ width: 'var(--diff-gutter-w)' }} />
                <col />
                <col style={{ width: 'var(--diff-gutter-w)' }} />
                <col />
              </colgroup>
            )}
            <tbody>{renderDiffRows()}</tbody>
          </table>
        </div>
        {showMinimap && (
          <ChangeMinimap
            ticks={nav.ticks}
            viewport={nav.viewport}
            scrollbarW={nav.scrollbarW}
            onGoToChange={nav.goToChange}
            onScrollToRatio={nav.scrollToRatio}
          />
        )}
      </div>
      {/* Outside the vertically-scrolling body, as a flex sibling — so the
          horizontal scrollbar is always pinned at the bottom of the diff pane
          and the user never has to scroll to the end of the file to reach it. */}
      {lockedScrollEnabled && (
        <div
          ref={hScrollRef}
          className={styles.diffHScroll}
          data-testid="diff-hscroll"
          aria-hidden="true"
        >
          <div ref={hScrollSpacerRef} className={styles.diffHScrollSpacer} />
        </div>
      )}
      {truncated && <DiffTruncationBanner prUrl={prUrl} />}
    </div>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  pair: DiffLine | null;
  threadsAtLine: ReviewThreadDto[] | undefined;
  filePath: string;
  colSpan: number;
  syntax: SyntaxTokenMaps;
  isFilled?: boolean;
  dataChangeStart?: number;
  dataChangeEnd?: number;
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
}

function DiffLineRow({
  line,
  pair,
  threadsAtLine,
  filePath,
  colSpan,
  syntax,
  isFilled,
  dataChangeStart,
  dataChangeEnd,
  onLineClick,
  renderComposerForLine,
  replyContext,
  collapse,
}: DiffLineRowProps) {
  const isAnchored = (threadsAtLine?.length ?? 0) > 0;
  const rowClass = `diff-line diff-line--${line.type}${isAnchored ? ' diff-line--commented' : ''}`;

  const renderContent = () => {
    if (line.type === 'hunk-header') {
      return <span className={`diff-hunk-header ${styles.diffHunkHeader}`}>{line.content}</span>;
    }

    if ((line.type === 'insert' || line.type === 'delete') && pair) {
      const oldText = line.type === 'delete' ? line.content : pair.content;
      const newText = line.type === 'insert' ? line.content : pair.content;
      const side = line.type === 'delete' ? 'old' : 'new';
      return (
        <MergedPairedContent
          syntax={syntax}
          side={side}
          lineNum={line.type === 'delete' ? line.oldLineNum : line.newLineNum}
          oldText={oldText}
          newText={newText}
        />
      );
    }

    // Side-aware: a unified delete line has no newLineNum — its tokens live on
    // the old side (mapHunks('old') keys delete lines by oldLineNum). Context &
    // insert lines use the new side. (The plan used 'new' only; that left
    // unified solo-delete lines as plaintext.)
    const side = line.type === 'delete' ? 'old' : 'new';
    const toks = tokensFor(syntax, side, side === 'old' ? line.oldLineNum : line.newLineNum);
    return <HighlightedLine spans={toks} fallback={normalizeEol(line.content)} />;
  };

  // PoC scope: only right-side (insert/context) clicks open the composer.
  // Left-side (deleted-line) commenting is deferred — its anchoredSha would
  // need to be the iteration's beforeSha, but FilesTab currently uses
  // prDetail.pr.headSha as the anchor (see deferrals doc). Once the
  // anchoredSha-by-iteration plumbing lands, this gate can flip to allow
  // line.type === 'delete' as well.
  const commentLineNum = line.newLineNum;
  const side: DraftSide = 'right';
  const canComment =
    onLineClick && commentLineNum !== null && (line.type === 'insert' || line.type === 'context');

  const handleClick = () => {
    if (!canComment || commentLineNum === null) return;
    onLineClick({
      filePath,
      lineNumber: commentLineNum,
      side,
      // anchoredSha is left empty here — DiffPane has no PR-detail context.
      // FilesTab.openComposerAt fills it in (PoC simplification: always
      // prDetail.pr.headSha; iteration-relative anchoring is deferred and
      // only right-side clicks are enabled, so headSha is always a valid
      // anchor for the right side).
      anchoredSha: '',
      anchoredLineContent: line.content,
    });
  };

  return (
    <>
      <tr
        className={rowClass}
        {...(isFilled ? { 'data-fill': 'true' } : {})}
        data-change-start={dataChangeStart}
        data-change-end={dataChangeEnd}
      >
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {line.oldLineNum ?? ''}
        </td>
        <NewGutterCell lineNum={line.newLineNum} onComment={canComment ? handleClick : undefined} />
        {/* The hunk-header row's <td> inherits the scaled font-size from the
            row, but its visible content is a fixed-size `.diffHunkHeader` span —
            so a font-size assertion against this cell would pass for the wrong
            reason. Skip the testid on hunk-header so e2e only measures real
            code cells (#135 review). */}
        <td
          className={`diff-content ${styles.diffContent}`}
          {...(line.type !== 'hunk-header' ? { 'data-testid': 'diff-code-line' } : {})}
        >
          {renderContent()}
        </td>
      </tr>
      {threadsAtLine && threadsAtLine.length > 0 && (
        <tr className={`diff-comment-row ${styles.diffCommentRow}`}>
          <td colSpan={colSpan}>
            <div className={styles.diffStickyViewport}>
              <ExistingCommentWidget
                threads={threadsAtLine}
                replyContext={replyContext}
                collapse={collapse}
              />
            </div>
          </td>
        </tr>
      )}
      {commentLineNum !== null && renderComposerForLine && (
        <ComposerSlot
          filePath={filePath}
          lineNumber={commentLineNum}
          colSpan={colSpan}
          render={renderComposerForLine}
        />
      )}
    </>
  );
}

type SplitRowKind = 'header' | 'paired' | 'context' | 'solo-delete' | 'solo-insert';

interface SplitDiffLineRowProps {
  kind: SplitRowKind;
  oldLineNum?: number | null;
  newLineNum?: number | null;
  oldText?: string;
  newText?: string;
  content?: string;
  filePath: string;
  syntax: SyntaxTokenMaps;
  isFilled?: boolean;
  isAnchored?: boolean;
  dataChangeStart?: number;
  dataChangeEnd?: number;
  onLineClick?: (anchor: InlineAnchor) => void;
}

function SplitDiffLineRow({
  kind,
  oldLineNum,
  newLineNum,
  oldText,
  newText,
  content,
  filePath,
  syntax,
  isFilled,
  isAnchored,
  dataChangeStart,
  dataChangeEnd,
  onLineClick,
}: SplitDiffLineRowProps) {
  if (kind === 'header') {
    return (
      <tr className="diff-line diff-line--hunk-header">
        {/* SplitDiffLineRow is only emitted from renderSplitRows (split mode = 4 columns always);
            full-width rows in mode-shared code paths use the mode-aware `colSpan` constant instead. */}
        <td colSpan={4}>
          <span className={`diff-hunk-header ${styles.diffHunkHeader}`}>{content}</span>
        </td>
      </tr>
    );
  }

  if (kind === 'context') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: content ?? '',
      });
    };
    return (
      <tr className="diff-line diff-line--context" {...(isFilled ? { 'data-fill': 'true' } : {})}>
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td
          data-side="old"
          className={`diff-content ${styles.diffContent}`}
          data-testid="diff-code-line"
        >
          <HighlightedLine
            spans={tokensFor(syntax, 'old', oldLineNum)}
            fallback={normalizeEol(content ?? '')}
          />
        </td>
        <NewGutterCell
          lineNum={newLineNum}
          onComment={newLineNum != null && onLineClick ? handleClick : undefined}
        />
        <td
          data-side="new"
          className={`diff-content ${styles.diffContent}`}
          data-testid="diff-code-line"
          {...(isAnchored ? { 'data-commented': 'true' } : {})}
        >
          <HighlightedLine
            spans={tokensFor(syntax, 'new', newLineNum)}
            fallback={normalizeEol(content ?? '')}
          />
        </td>
      </tr>
    );
  }

  if (kind === 'solo-delete') {
    return (
      <tr
        className="diff-line diff-line--delete"
        aria-label={`Removed line ${oldLineNum ?? '?'}`}
        data-change-start={dataChangeStart}
        data-change-end={dataChangeEnd}
      >
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td
          data-side="old"
          className={`diff-content ${styles.diffContent}`}
          data-testid="diff-code-line"
        >
          <HighlightedLine
            spans={tokensFor(syntax, 'old', oldLineNum)}
            fallback={normalizeEol(content ?? '')}
          />
        </td>
        <td
          aria-hidden="true"
          className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew} ${styles.diffCellEmpty}`}
        ></td>
        <td
          aria-hidden="true"
          data-side="new"
          className={`diff-content ${styles.diffContent} ${styles.diffCellEmpty}`}
        ></td>
      </tr>
    );
  }

  if (kind === 'solo-insert') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: content ?? '',
      });
    };
    return (
      <tr
        className="diff-line diff-line--insert"
        aria-label={`Added line ${newLineNum ?? '?'}`}
        data-change-start={dataChangeStart}
        data-change-end={dataChangeEnd}
      >
        <td
          aria-hidden="true"
          className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld} ${styles.diffCellEmpty}`}
        ></td>
        <td
          aria-hidden="true"
          data-side="old"
          className={`diff-content ${styles.diffContent} ${styles.diffCellEmpty}`}
        ></td>
        <NewGutterCell
          lineNum={newLineNum}
          onComment={newLineNum != null && onLineClick ? handleClick : undefined}
        />
        <td
          data-side="new"
          className={`diff-content ${styles.diffContent}`}
          data-testid="diff-code-line"
          {...(isAnchored ? { 'data-commented': 'true' } : {})}
        >
          <HighlightedLine
            spans={tokensFor(syntax, 'new', newLineNum)}
            fallback={normalizeEol(content ?? '')}
          />
        </td>
      </tr>
    );
  }

  if (kind === 'paired') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: newText ?? '',
      });
    };
    return (
      <tr
        className="diff-line diff-line--paired"
        data-change-start={dataChangeStart}
        data-change-end={dataChangeEnd}
      >
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td
          data-side="old"
          className={`diff-content ${styles.diffContent}`}
          data-testid="diff-code-line"
        >
          <MergedPairedContent
            syntax={syntax}
            side="old"
            lineNum={oldLineNum}
            oldText={oldText ?? ''}
            newText={newText ?? ''}
          />
        </td>
        <NewGutterCell
          lineNum={newLineNum}
          onComment={newLineNum != null && onLineClick ? handleClick : undefined}
        />
        <td
          data-side="new"
          className={`diff-content ${styles.diffContent}`}
          data-testid="diff-code-line"
          {...(isAnchored ? { 'data-commented': 'true' } : {})}
        >
          <MergedPairedContent
            syntax={syntax}
            side="new"
            lineNum={newLineNum}
            oldText={oldText ?? ''}
            newText={newText ?? ''}
          />
        </td>
      </tr>
    );
  }

  return null;
}

// A row that renders the composer iff the parent's renderComposerForLine
// returns non-null for the given line. Avoids putting `if (active)` logic
// into DiffPane itself.
function ComposerSlot({
  filePath,
  lineNumber,
  colSpan,
  render,
}: {
  filePath: string;
  lineNumber: number;
  colSpan: number;
  render: (filePath: string, lineNumber: number) => React.ReactNode;
}) {
  const node = render(filePath, lineNumber);
  if (!node) return null;
  return (
    <tr className={`diff-composer-row ${styles.diffComposerRow}`}>
      <td colSpan={colSpan}>
        <div className={styles.diffStickyViewport}>{node}</div>
      </td>
    </tr>
  );
}
