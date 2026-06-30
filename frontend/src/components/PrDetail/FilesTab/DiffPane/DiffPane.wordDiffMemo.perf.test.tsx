import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { diffWordsWithSpace } from 'diff';
import { DiffPane } from './DiffPane';
import type { FileChange, PrReference } from '../../../../api/types';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';
import { getHighlighterAsync } from '../../../Markdown/shikiInstance';

vi.mock('../../../../hooks/useWholeFileContent');

// `diff@9` is externalized ESM — its named export can't be redefined in place
// (vi.spyOn no-ops), so wrap it via a factory that preserves the real impl
// (output stays identical) while counting calls.
vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return { ...actual, diffWordsWithSpace: vi.fn(actual.diffWordsWithSpace) };
});

const prRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// A paired (modify) line — `return 0;` → `return 1;` — drives MergedPairedContent's
// token-path word-diff. Valid TS so shiki tokenizes it and the token concatenation
// equals the line content (the blob-equality guard passes → the word-diff runs,
// rather than falling back to WordDiffOverlay).
const file: FileChange = {
  path: 'src/main.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      body: '@@ -1,3 +1,3 @@\n function a() {\n-  return 0;\n+  return 1;\n }',
    },
  ],
};

const paneProps = (overrides: { truncated: boolean }) => ({
  prRef,
  selectedPath: 'src/main.ts',
  file,
  diffMode: 'side-by-side' as const,
  reviewThreads: [],
  prUrl: '',
  headSha: 'h',
  baseSha: 'b',
  ...overrides,
});

describe('DiffPane word-diff memoization (#670)', () => {
  beforeEach(() => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
    vi.mocked(diffWordsWithSpace).mockClear();
  });

  // Guards change #2 specifically (the per-paired-line word-diff is not recomputed
  // on an unrelated re-render). It does NOT prove the whole perf claim — the
  // row-reconciliation cost is covered by DiffPane.rowMemo.perf.test.tsx.
  it('does not recompute the per-paired-line word-diff on an unrelated re-render', async () => {
    await getHighlighterAsync();
    const { container, rerender } = render(<DiffPane {...paneProps({ truncated: false })} />);

    // Wait until syntax tokens land so the word-diff token path executed at least once.
    await waitFor(() => expect(container.querySelector('.codeToken')).not.toBeNull());
    await waitFor(() => expect(vi.mocked(diffWordsWithSpace).mock.calls.length).toBeGreaterThan(0));

    // Reset the counter, then trigger an unrelated re-render: toggling `truncated`
    // adds a banner below the table but changes no row prop. With the memo, every
    // paired-line MergedPairedContent bails and the word-diff is not re-run.
    vi.mocked(diffWordsWithSpace).mockClear();
    rerender(<DiffPane {...paneProps({ truncated: true })} />);

    expect(vi.mocked(diffWordsWithSpace)).not.toHaveBeenCalled();
  });
});
