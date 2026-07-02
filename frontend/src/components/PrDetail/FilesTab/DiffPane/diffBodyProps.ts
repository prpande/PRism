import type { ReviewThreadDto, HunkAnnotation, DiffLine } from '../../../../api/types';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import type {
  ExistingCommentWidgetReplyContext,
  ThreadCollapseControl,
} from './ExistingCommentWidget';
import type { SyntaxTokenMaps } from '../../../../hooks/useSyntaxTokens';

// Shared props for UnifiedDiffBody / SplitDiffBody — the explicit form of
// everything the former renderUnifiedRows/renderSplitRows closures captured
// from DiffPane's scope.
export interface DiffBodyProps {
  selectedPath: string;
  lines: DiffLine[]; // = DiffPane's allLines
  threadsByLine: Map<number, ReviewThreadDto[]>;
  annotationsForFile: Map<number, HunkAnnotation[]> | null; // hunk mode
  annotationsByRowIdx: Map<number, HunkAnnotation[]> | null; // whole-file mode
  // True iff whole-file view is enabled AND its content fetch succeeded —
  // DiffPane computes `wholeFileEnabled && fetchStatus === 'ok'` once and
  // passes the conjunction; the bodies never branch on the raw pieces.
  wholeFileOk: boolean;
  colSpan: number;
  syntax: SyntaxTokenMaps;
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  // #327 Task 12 — composite key of every location where renderComposerForLine
  // returns content (the open composer's line + each un-deduped new-inline
  // placeholder's line): sorted `${filePath}:${lineNumber}=${stamp}` entries
  // joined with NUL ('\0' — the one character git forbids in paths), or null
  // when none (the stamp — `c:${draftId}:${anyOtherDraftsStaged}` for the
  // composer plus placeholder clientIds — distinguishes WHAT renders there
  // and carries the mounted composer's reactive content, so post-now's
  // same-line composer→placeholder swap, an autosave-assigned draft id, and a
  // post-now-gate flip all change the key).
  // renderComposerForLine is identity-stable, so this key is what breaks the
  // body memo when composer content appears, moves, changes, or disappears.
  // UnifiedDiffBody derives a per-row stamp from it — the raw key must NEVER
  // be passed to rows, or every row's memo would break on each composer move.
  activeComposerKey: string | null;
  // #327 Task 13 — the STABLE callbacks bag only (identity changes only on
  // prRef/prState/readOnly). The churning per-thread reply DATA flows through
  // ReplyDataContext (consumed inside ExistingCommentWidget), so an autosave
  // refetch never breaks the body/row memos via this prop.
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
  changeStartMap: Map<number, number>;
  changeEndMap: Map<number, number>;
}
