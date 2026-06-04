import { describe, it, expect } from 'vitest';
import { mergeWordDiffWithTokens } from '../src/components/PrDetail/FilesTab/DiffPane/mergeWordDiff';
import type { LineToken } from '../src/components/Markdown/shikiInstance';
import { diffWordsWithSpace } from 'diff';

const tok = (text: string): LineToken => ({ text, style: {} });

describe('mergeWordDiffWithTokens', () => {
  it('marks added words on the new side, leaving unchanged text plain', () => {
    const oldText = 'const x = 1;';
    const newText = 'const y = 1;';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(newText, [tok(newText)], parts, 'new');
    expect(spans.map((s) => s.text).join('')).toBe(newText);
    const changed = spans
      .filter((s) => s.change === 'insert')
      .map((s) => s.text)
      .join('');
    expect(changed).toContain('y');
    expect(spans.find((s) => s.text.includes('const'))!.change).toBeUndefined();
  });

  it('splits at the union of token and word-diff boundaries', () => {
    const oldText = 'xx yy';
    const newText = 'xx zz';
    const parts = diffWordsWithSpace(oldText, newText);
    // The token boundary ('xx z' | 'z') deliberately falls INSIDE the changed
    // word 'zz', so the merge must split on both token and change boundaries.
    const spans = mergeWordDiffWithTokens(newText, [tok('xx z'), tok('z')], parts, 'new');
    expect(spans.map((s) => s.text).join('')).toBe('xx zz');
    // The unchanged prefix stays plain; the whole changed word 'zz' is flagged
    // insert even though it straddles the token split.
    const changed = spans
      .filter((s) => s.change === 'insert')
      .map((s) => s.text)
      .join('');
    expect(changed).toBe('zz');
    expect(spans.some((s) => s.text.startsWith('xx') && s.change === undefined)).toBe(true);
  });

  it('stays aligned when sides differ in whitespace (round-1 regression)', () => {
    const oldText = '\tif (x)   return;';
    const newText = '    if (y) return;';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(newText, [tok(newText)], parts, 'new');
    // text is reproduced exactly — no normalization drift
    expect(spans.map((s) => s.text).join('')).toBe(newText);
  });

  it('marks removed words on the old side as delete', () => {
    const oldText = 'foo(a, b)';
    const newText = 'foo(b)';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(oldText, [tok(oldText)], parts, 'old');
    expect(spans.map((s) => s.text).join('')).toBe(oldText);
    expect(spans.some((s) => s.change === 'delete')).toBe(true);
  });

  it('handles a capped single plaintext token (still backgrounds changes)', () => {
    const oldText = 'a';
    const newText = 'b';
    const parts = diffWordsWithSpace(oldText, newText);
    const spans = mergeWordDiffWithTokens(newText, [tok('b')], parts, 'new');
    expect(spans).toEqual([{ text: 'b', style: {}, change: 'insert' }]);
  });
});
