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
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
  changeStartMap: Map<number, number>;
  changeEndMap: Map<number, number>;
  // slice 2 (Task 12) EXTENDS this interface with: activeComposerKey: string | null
  // — the body memo wrappers will gain that dep then; don't design it out.
}
