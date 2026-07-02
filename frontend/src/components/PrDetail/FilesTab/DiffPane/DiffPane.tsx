import { useEffect, useMemo, useRef } from 'react';
import type {
  FileChange,
  ReviewThreadDto,
  PrReference,
  HunkAnnotation,
  DiffLine,
} from '../../../../api/types';
import { prRefKey } from '../../../../api/types';
import { useDiffScrollCapture } from '../../../../hooks/diffScrollMemory';
import { parseHunkLines, interleaveWholeFile } from './interleaveWholeFile';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import type {
  ExistingCommentWidgetReplyContext,
  ThreadCollapseControl,
} from './ExistingCommentWidget';
import { DiffTruncationBanner } from './DiffTruncationBanner';
import { UnifiedDiffBody } from './UnifiedDiffBody';
import { SplitDiffBody } from './SplitDiffBody';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';
import { useLockedPaneScroll } from '../../../../hooks/useLockedPaneScroll';
import { useDiffViewportWidthVar } from '../../../../hooks/useDiffViewportWidthVar';
import { useSyntaxTokens } from '../../../../hooks/useSyntaxTokens';
import { pathToLang } from '../../../Markdown/shikiInstance';
import { WholeFileFailureBanner } from './WholeFileFailureBanner';
import { useWholeFileFailureLatch } from './useWholeFileFailureLatch';
import { Spinner } from '../../../Spinner';
import { computeChanges } from '../DiffChangeNav/diffChanges';
import { useChangeNavigation } from '../DiffChangeNav/useChangeNavigation';
import { ChangeNavControls } from '../DiffChangeNav/ChangeNavControls';
import { ChangeMinimap } from '../DiffChangeNav/ChangeMinimap';
import { isInputTarget } from '../../../../hooks/isInputTarget';
import styles from './DiffPane.module.css';

export type DiffMode = 'side-by-side' | 'unified';

export interface DiffPaneProps {
  prRef: PrReference;
  selectedPath: string | null;
  file: FileChange | null;
  diffMode: DiffMode;
  truncated: boolean;
  reviewThreads: ReviewThreadDto[];
  htmlUrl?: string;
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

export function DiffPane({
  prRef,
  selectedPath,
  file,
  diffMode,
  truncated,
  reviewThreads,
  htmlUrl,
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

  // The one whole-file condition the render path branches on: enabled AND the
  // content fetch succeeded. Computed once; the diff bodies receive it as the
  // single `wholeFileOk` prop (they never see the raw enabled/fetchStatus pair).
  const wholeFileOk = wholeFileEnabled && wholeFile.fetchStatus === 'ok';

  const syntax = useSyntaxTokens({
    path: selectedPath,
    file,
    wholeFileEnabled,
    wholeFile,
    isSplit,
    headSha,
    baseSha,
  });

  const {
    failure: localFailure,
    dismiss: dismissBanner,
    retry: retryWholeFile,
  } = useWholeFileFailureLatch({
    fetchStatus: wholeFile.fetchStatus,
    failureReason: wholeFile.failureReason,
    selectedPath,
    onWholeFileFailed,
    onWholeFileRetry,
  });

  // allLines: whole-file branch takes over when enabled + ok; else plain hunk
  // parsing.
  const allLines: DiffLine[] = useMemo(() => {
    if (!file) return [];
    if (wholeFileOk && wholeFile.headContent !== null) {
      return interleaveWholeFile(file, wholeFile.headContent, wholeFile.baseContent);
    }
    const out: DiffLine[] = [];
    for (const hunk of file.hunks) {
      out.push(...parseHunkLines(hunk.body));
    }
    return out;
  }, [file, wholeFileOk, wholeFile.headContent, wholeFile.baseContent]);

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
    if (!wholeFileOk) return null;
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
  }, [wholeFileOk, allLines, annotationsForFile]);

  // Scroll reset on wholeFileEnabled toggle or file navigation.
  const diffBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (diffBodyRef.current) diffBodyRef.current.scrollTop = 0;
  }, [wholeFileEnabled, selectedPath]);

  // #590 — record this diff body's live scrollTop so PrDetailView can restore it
  // when the kept-alive Files tab re-activates (deactivation's data-files-active
  // removal otherwise clamps it to 0). `diffBodyPresent` mirrors the final-branch
  // guard below so the listener (re)attaches exactly when the scrollable body
  // exists — including a late first diff-load.
  const diffBodyPresent =
    !!selectedPath && !(isLoading && !file) && !!file && file.hunks.length > 0;
  useDiffScrollCapture(diffBodyRef, prRefKey(prRef), diffBodyPresent);

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
  // (selectedPath + the DERIVED whole-file mode; see the scroll-reset effect
  // above) — so the two stay in
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

  // #670: review threads for the open file, indexed by line. Memoized like every
  // other derived structure here (allLines, changes, the boundary maps) so it is
  // not rebuilt every render — and, critically, so each row receives a stable
  // `threadsAtLine` reference, the precondition for the row React.memo (DiffLineRow) to
  // bail on an unrelated re-render. Keyed on [reviewThreads, selectedPath]; both
  // are available before the early-return guards, and a null selectedPath simply
  // yields an empty map (the !selectedPath guard returns before it is read).
  const threadsByLine = useMemo(() => {
    const map = new Map<number, ReviewThreadDto[]>();
    for (const t of reviewThreads) {
      if (t.filePath !== selectedPath) continue;
      const existing = map.get(t.lineNumber);
      if (existing) existing.push(t);
      else map.set(t.lineNumber, [t]);
    }
    return map;
  }, [reviewThreads, selectedPath]);

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

  const colSpan = isSplit ? 4 : 3;
  const modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified';
  const wrapClass = lineWrap ? ' diff-pane--wrap' : '';
  // Both bodies implement DiffBodyProps; only the tag differs by mode.
  const Body = isSplit ? SplitDiffBody : UnifiedDiffBody;

  // The minimap renders only in whole-file mode when the content overflows and
  // has changes. The native vertical scrollbar is hidden under exactly the same
  // condition — never hide it without the rail there to replace it.
  const showMinimap = wholeFileOk && nav.hasOverflow && changes.length > 0;

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
            <tbody>
              <Body
                selectedPath={selectedPath}
                lines={allLines}
                threadsByLine={threadsByLine}
                annotationsForFile={annotationsForFile}
                annotationsByRowIdx={annotationsByRowIdx}
                wholeFileOk={wholeFileOk}
                colSpan={colSpan}
                syntax={syntax}
                onLineClick={onLineClick}
                renderComposerForLine={renderComposerForLine}
                replyContext={replyContext}
                collapse={collapse}
                changeStartMap={changeStartMap}
                changeEndMap={changeEndMap}
              />
            </tbody>
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
      {truncated && <DiffTruncationBanner htmlUrl={htmlUrl} />}
    </div>
  );
}
