import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiffPane } from './DiffPane';
import type { FileChange, ReviewThreadDto, PrReference } from '../../../../api/types';
import type { DiffMode } from './DiffPane';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';

vi.mock('../../../../hooks/useWholeFileContent');

// Count HighlightedLine renders without source instrumentation: a row that bails
// (React.memo) never re-invokes its HighlightedLine child. Context/solo rows render
// HighlightedLine directly (not via the memoized MergedPairedContent), so this
// isolates ROW-level re-render from change #2's word-diff memo.
const hl = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../Markdown/HighlightedLine', () => ({
  HighlightedLine: () => {
    hl.count += 1;
    return null;
  },
}));

// Pin syntax to a stable, ready, empty map: no async token-arrival re-render to
// pollute the count, and a single `syntax` identity across renders (which the real
// useSyntaxTokens also guarantees via its useMemo'd EMPTY sentinel). Empty tokens
// route context/solo lines through HighlightedLine's plaintext fallback.
vi.mock('../../../../hooks/useSyntaxTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../hooks/useSyntaxTokens')>();
  const EMPTY = { oldLineTokens: new Map(), newLineTokens: new Map(), ready: true } as const;
  return { ...actual, useSyntaxTokens: () => EMPTY };
});

const prRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

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

const threadAtLine1: ReviewThreadDto = {
  threadId: 't1',
  filePath: 'src/main.ts',
  lineNumber: 1,
  isResolved: false,
  comments: [
    {
      commentId: 'c1',
      author: 'amelia.cho',
      avatarUrl: null,
      createdAt: '2026-05-18T00:00:00Z',
      body: 'Guard against overflow?',
      editedAt: null,
    },
  ],
};

// Stable reference across renders — models the scroll case this change targets, where
// DiffPane re-renders but FilesTab does not, so reviewThreads keeps its identity. (A
// fresh array literal each render would correctly bust the threadsByLine memo — that
// is the deferred FilesTab-originated re-render case, not the scroll case.)
const stableThreads: ReviewThreadDto[] = [threadAtLine1];

const paneProps = (overrides: {
  diffMode: DiffMode;
  reviewThreads: ReviewThreadDto[];
  truncated: boolean;
}) => ({
  prRef,
  selectedPath: 'src/main.ts',
  file,
  htmlUrl: '',
  headSha: 'h',
  baseSha: 'b',
  ...overrides,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('DiffPane row memoization (#670)', () => {
  beforeEach(() => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
    hl.count = 0;
  });

  // Change #3: SplitDiffLineRow is React.memo'd, so an unrelated re-render does not
  // reconcile every row. Split mode is the default review mode.
  it('does not re-render rows on an unrelated re-render (split mode)', async () => {
    const { rerender } = render(
      <DiffPane
        {...paneProps({ diffMode: 'side-by-side', reviewThreads: [], truncated: false })}
      />,
    );
    await flush();
    expect(hl.count).toBeGreaterThan(0); // sanity: rows rendered

    hl.count = 0;
    rerender(
      <DiffPane {...paneProps({ diffMode: 'side-by-side', reviewThreads: [], truncated: true })} />,
    );
    expect(hl.count).toBe(0);
  });

  // Changes #1 + #3 together: a threaded row in unified mode bails only when its
  // `threadsAtLine` reference is stable (threadsByLine is memoized) AND DiffLineRow
  // is React.memo'd.
  it('does not re-render a threaded row on an unrelated re-render (unified mode)', async () => {
    const { rerender } = render(
      <DiffPane
        {...paneProps({ diffMode: 'unified', reviewThreads: stableThreads, truncated: false })}
      />,
    );
    await flush();
    expect(hl.count).toBeGreaterThan(0);

    hl.count = 0;
    rerender(
      <DiffPane
        {...paneProps({ diffMode: 'unified', reviewThreads: stableThreads, truncated: true })}
      />,
    );
    expect(hl.count).toBe(0);
  });
});
