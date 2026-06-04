import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { FileChange, PrReference } from '../src/api/types';

// MergedPairedContent has a correctness-critical drift guard: when the syntax
// tokens for a paired line do NOT concatenate to that side's content, it must
// fall back to WordDiffOverlay rather than feed mismatched coordinate spaces to
// the word-diff index walk (which would silently mis-highlight). That guard is
// otherwise unexercised, so this file mocks useSyntaxTokens to return a token
// map deliberately keyed to the right line but carrying the WRONG text, then
// asserts the real line content renders (via the overlay) and the bogus token
// text does not. The mock is isolated to this file so the real-token tests in
// DiffPane.highlight.test.tsx keep using the genuine hook.
vi.mock('../src/hooks/useSyntaxTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/useSyntaxTokens')>();
  return {
    ...actual, // keep the real normalizeEol (DiffPane imports it from here)
    useSyntaxTokens: () => ({
      ready: true,
      // Non-empty (so the toks.length === 0 guard does NOT fire) but wrong text,
      // so only the sideText !== expected drift guard can trigger the fallback.
      oldLineTokens: new Map([[1, [{ text: 'WRONG OLD TOKEN', style: {} }]]]),
      newLineTokens: new Map([[1, [{ text: 'WRONG NEW TOKEN', style: {} }]]]),
    }),
  };
});

// Import AFTER the mock is registered.
const { DiffPane } = await import('../src/components/PrDetail/FilesTab/DiffPane/DiffPane');

const prRef: PrReference = { owner: 'o', repo: 'r', number: 1 };
const paired = {
  path: 'a.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      body: '@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;',
    },
  ],
} as unknown as FileChange;

describe('DiffPane paired-line drift guard', () => {
  it('falls back to WordDiffOverlay when tokens do not match the line content', () => {
    const { container } = render(
      <DiffPane
        prRef={prRef}
        selectedPath="a.ts"
        file={paired}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        headSha="h"
        baseSha="b"
      />,
    );
    // The real content renders (via the overlay fallback)...
    expect(container.textContent).toContain('const a = 1;');
    expect(container.textContent).toContain('const a = 2;');
    // ...and the mismatched token text is never shown (guard rejected it).
    expect(container.textContent).not.toContain('WRONG NEW TOKEN');
    expect(container.textContent).not.toContain('WRONG OLD TOKEN');
    // No syntax tokens were emitted for the paired line — the guard skipped them.
    expect(container.querySelector('.codeToken')).toBeNull();
  });
});
