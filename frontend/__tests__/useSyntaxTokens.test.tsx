import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useSyntaxTokens } from '../src/hooks/useSyntaxTokens';
import { getHighlighterAsync } from '../src/components/Markdown/shikiInstance';
import type { FileChange } from '../src/api/types';

const file = (body: string): FileChange =>
  ({
    path: 'a.ts',
    status: 'modified',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body }],
  }) as unknown as FileChange;

const okWhole = {
  fetchStatus: 'ok' as const,
  headContent: '',
  baseContent: null,
  failureReason: null,
};

describe('useSyntaxTokens', () => {
  it('returns empty maps for an unsupported path', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'LICENSE',
        file: file('@@ -1 +1 @@\n+const x = 1;'),
        wholeFileEnabled: false,
        wholeFile: { ...okWhole, fetchStatus: 'idle' },
        isSplit: true,
        headSha: 'h',
        baseSha: 'b',
      }),
    );
    expect(result.current.newLineTokens.size).toBe(0);
  });

  it('tokenizes hunk-mode new-side lines keyed by newLineNum', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'a.ts',
        file: file('@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;'),
        wholeFileEnabled: false,
        wholeFile: { ...okWhole, fetchStatus: 'idle' },
        isSplit: true,
        headSha: 'h',
        baseSha: 'b',
      }),
    );
    await waitFor(() => expect(result.current.newLineTokens.size).toBeGreaterThan(0));
    // context line 1 + insert line 2 both keyed on the new side
    expect(result.current.newLineTokens.has(1)).toBe(true);
    expect(result.current.newLineTokens.has(2)).toBe(true);
    const concat = result.current.newLineTokens
      .get(2)!
      .map((t) => t.text)
      .join('');
    expect(concat).toBe('const b = 2;');
  });

  it('tokenizes whole-file split base content for the old side', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'a.ts',
        file: file('@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;'),
        wholeFileEnabled: true,
        wholeFile: {
          fetchStatus: 'ok',
          headContent: 'const a = 2;',
          baseContent: 'const a = 1;',
          failureReason: null,
        },
        isSplit: true,
        headSha: 'h',
        baseSha: 'b',
      }),
    );
    await waitFor(() => expect(result.current.oldLineTokens.size).toBeGreaterThan(0));
    expect(
      result.current.oldLineTokens
        .get(1)!
        .map((t) => t.text)
        .join(''),
    ).toBe('const a = 1;');
  });

  it('returns empty maps when file is null', async () => {
    await getHighlighterAsync();
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'a.ts',
        file: null,
        wholeFileEnabled: false,
        wholeFile: { ...okWhole, fetchStatus: 'idle' },
        isSplit: true,
        headSha: 'h',
        baseSha: 'b',
      }),
    );
    expect(result.current.newLineTokens.size).toBe(0);
    expect(result.current.oldLineTokens.size).toBe(0);
  });

  it('suppresses whole-file tokens past the large-file line guard', async () => {
    await getHighlighterAsync();
    const big = Array.from({ length: 2001 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const { result } = renderHook(() =>
      useSyntaxTokens({
        path: 'a.ts',
        file: file('@@ -1,1 +1,1 @@\n-x\n+y'),
        wholeFileEnabled: true,
        wholeFile: { fetchStatus: 'ok', headContent: big, baseContent: null, failureReason: null },
        isSplit: true,
        headSha: 'h',
        baseSha: 'b',
      }),
    );
    // Whole-file new side is too large → mapWhole returns empty; no whole-file tokens.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current.newLineTokens.size).toBe(0);
  });
});
