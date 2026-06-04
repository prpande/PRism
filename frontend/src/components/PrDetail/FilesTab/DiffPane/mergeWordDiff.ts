import type { Change } from 'diff';
import type { MergedSpan } from '../../../Markdown/HighlightedLine';
import type { LineToken } from '../../../Markdown/shikiInstance';

// `sideText` is the authoritative index space — the exact string tokenizeLines
// tokenized for this side. `wordDiffParts` MUST come from diffWordsWithSpace
// (whitespace significant) so the per-side concatenation equals sideText.
export function mergeWordDiffWithTokens(
  sideText: string,
  tokens: LineToken[],
  wordDiffParts: Change[],
  side: 'old' | 'new',
): MergedSpan[] {
  // 1. Flag changed characters in sideText coordinates.
  const changed = new Array<boolean>(sideText.length).fill(false);
  let cursor = 0;
  for (const part of wordDiffParts) {
    const belongsToSide = side === 'old' ? !part.added : !part.removed;
    if (!belongsToSide) continue;
    const len = part.value.length;
    const isChange = side === 'old' ? part.removed : part.added;
    if (isChange) {
      for (let i = cursor; i < cursor + len; i++) changed[i] = true;
    }
    cursor += len;
  }

  // 2. Walk tokens, splitting each at change-flag transitions.
  const spans: MergedSpan[] = [];
  let pos = 0;
  for (const t of tokens) {
    let i = 0;
    while (i < t.text.length) {
      const flag = changed[pos + i];
      let j = i + 1;
      while (j < t.text.length && changed[pos + j] === flag) j++;
      const span: MergedSpan = { text: t.text.slice(i, j), style: t.style };
      if (flag) span.change = side === 'old' ? 'delete' : 'insert';
      spans.push(span);
      i = j;
    }
    pos += t.text.length;
  }
  return spans;
}
