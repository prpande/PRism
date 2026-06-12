import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DiffPane } from './DiffPane';
import type { FileChange, ReviewThreadDto } from '../../../../api/types';

// DiffPane pulls AI + whole-file + syntax hooks that hit context/network; stub
// them so it renders standalone in jsdom. This harness exists to prove every
// full-span comment/composer cell is wrapped in `.diffStickyViewport` (#390).
vi.mock('../../../../hooks/useAiGate', () => ({ useAiGate: () => false }));
vi.mock('../../../../hooks/useAiHunkAnnotations', () => ({ useAiHunkAnnotations: () => null }));
vi.mock('../../../../hooks/useWholeFileContent', () => ({
  useWholeFileContent: () => ({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  }),
}));
vi.mock('../../../../hooks/useSyntaxTokens', () => ({
  useSyntaxTokens: () => ({ oldLineTokens: new Map(), newLineTokens: new Map(), ready: true }),
  normalizeEol: (s: string) => s.replace(/\r$/, ''),
}));

const prRef = { owner: 'acme', repo: 'api', number: 1 };

// one hunk with an inserted line at new-line 5, matching the thread below.
const file: FileChange = {
  path: 'src/a.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 5,
      oldLines: 0,
      newStart: 5,
      newLines: 1,
      body: '@@ -5,0 +5,1 @@\n+const x = 1;\n',
    },
  ],
};

const threadOnLine5 = {
  threadId: 't1',
  filePath: 'src/a.ts',
  lineNumber: 5,
  isResolved: false,
  comments: [
    {
      commentId: 'c1',
      author: 'amelia.cho',
      avatarUrl: null,
      body: 'hi',
      createdAt: '2026-05-18T00:00:00Z',
    },
  ],
} as ReviewThreadDto;

function renderDiffPane(diffMode: 'unified' | 'side-by-side') {
  return render(
    <DiffPane
      prRef={prRef}
      selectedPath="src/a.ts"
      file={file}
      diffMode={diffMode}
      truncated={false}
      reviewThreads={[threadOnLine5]}
      renderComposerForLine={() => <div data-testid="composer-stub" />}
    />,
  );
}

describe('DiffPane sticky viewport wrap (#390)', () => {
  it.each(['unified', 'side-by-side'] as const)(
    'wraps the comment widget + composer cells in .diffStickyViewport (%s)',
    (mode) => {
      const { container } = renderDiffPane(mode);
      // CSS-module classes are hashed in tests (_diffStickyViewport_xxx); match by substring.
      // one wrapper for the ExistingCommentWidget cell + one for the composer cell
      expect(
        container.querySelectorAll('[class*="diffStickyViewport"]').length,
      ).toBeGreaterThanOrEqual(2);
    },
  );
});
