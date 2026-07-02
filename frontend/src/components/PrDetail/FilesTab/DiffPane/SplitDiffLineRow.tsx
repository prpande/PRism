import { memo } from 'react';
import type { InlineAnchor } from '../../Composer/InlineCommentComposer';
import { normalizeEol, type SyntaxTokenMaps } from '../../../../hooks/useSyntaxTokens';
import { HighlightedLine } from '../../../Markdown/HighlightedLine';
import { MergedPairedContent, tokensFor } from './MergedPairedContent';
import { NewGutterCell, makeGutterClick } from './gutter';
import styles from './DiffPane.module.css';

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

// #670: memoized alongside DiffLineRow (see its note). Split mode is the default
// review mode, and SplitDiffLineRow takes no render-prop callback, so all its props
// are referentially stable across a scroll re-render and it bails cleanly.
export const SplitDiffLineRow = memo(function SplitDiffLineRow({
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
    const handleClick =
      newLineNum != null
        ? makeGutterClick({
            onLineClick,
            filePath,
            lineNumber: newLineNum,
            side: 'right',
            anchoredLineContent: content ?? '',
          })
        : undefined;
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
        <NewGutterCell lineNum={newLineNum} onComment={handleClick} />
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
    const handleClick =
      newLineNum != null
        ? makeGutterClick({
            onLineClick,
            filePath,
            lineNumber: newLineNum,
            side: 'right',
            anchoredLineContent: content ?? '',
          })
        : undefined;
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
        <NewGutterCell lineNum={newLineNum} onComment={handleClick} />
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
    const handleClick =
      newLineNum != null
        ? makeGutterClick({
            onLineClick,
            filePath,
            lineNumber: newLineNum,
            side: 'right',
            anchoredLineContent: newText ?? '',
          })
        : undefined;
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
        <NewGutterCell lineNum={newLineNum} onComment={handleClick} />
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
});
