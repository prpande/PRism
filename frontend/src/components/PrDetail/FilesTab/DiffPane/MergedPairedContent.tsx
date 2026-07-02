import { memo } from 'react';
import { WordDiffOverlay } from './WordDiffOverlay';
import { normalizeEol, type SyntaxTokenMaps } from '../../../../hooks/useSyntaxTokens';
import { HighlightedLine } from '../../../Markdown/HighlightedLine';
import { type LineToken } from '../../../Markdown/shikiInstance';
import { mergeWordDiffWithTokens } from './mergeWordDiff';
import { diffWordsWithSpace } from 'diff';

// Look up the syntax tokens for a single diff line, keyed by 1-based line
// number on the requested side. Returns [] when the line has no number on
// that side (e.g. a delete line has no new-side number) or the map has no
// entry — HighlightedLine then renders its plaintext fallback.
export function tokensFor(
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
//
// #670: memoized so the per-paired-line `diffWordsWithSpace` runs only when this
// line's inputs actually change. All props are referentially stable across an
// unrelated re-render — `syntax` is a `useMemo`'d object (stable `EMPTY` sentinel
// until tokens change); `side`/`lineNum`/`oldText`/`newText` derive from memoized
// `allLines`. Memoizing the component (rather than an internal `useMemo`) caches
// the fallback branches too and avoids a rules-of-hooks hazard with the two early
// returns below. Default shallow compare is correct: the output is a pure function
// of these props.
export const MergedPairedContent = memo(function MergedPairedContent({
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
  // #670: the React.memo wrapper above means this word-diff runs only when this
  // line's inputs change, not on every render. One residual case remains: a theme
  // toggle changes `syntax` identity, so the memo re-runs diffWordsWithSpace on
  // toggle (theme-independent work). Caching across themes is a deferred non-goal —
  // see docs/specs/2026-07-01-diffpane-render-perf-design.md.
  const parts = diffWordsWithSpace(normalizeEol(oldText), normalizeEol(newText));
  const spans = mergeWordDiffWithTokens(sideText, toks, parts, side);
  return <HighlightedLine spans={spans} fallback={sideText} />;
});
