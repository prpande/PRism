import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiffPane } from './DiffPane';
import type { FileChange, ReviewThreadDto, PrReference } from '../../../../api/types';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';

vi.mock('../../../../hooks/useWholeFileContent');

const prRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// One-file diff: line 1 is context (new-side line 1), so a thread anchored at
// new-side line 1 should mark the context row.
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
  anchorSha: 'abc123',
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

describe('DiffPane commented-line highlight', () => {
  beforeEach(() => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
  });

  it('marks the commented diff line with diff-line--commented (unified)', () => {
    const { container } = render(
      <DiffPane
        prRef={prRef}
        selectedPath="src/main.ts"
        file={file}
        diffMode="unified"
        truncated={false}
        reviewThreads={[threadAtLine1]}
        prUrl=""
      />,
    );
    const commentedRow = container.querySelector('tr.diff-line--commented');
    expect(commentedRow).not.toBeNull();
  });
});
