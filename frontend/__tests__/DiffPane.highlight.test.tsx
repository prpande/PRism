import { render, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffPane } from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane';
import { getHighlighterAsync } from '../src/components/Markdown/shikiInstance';
import type { FileChange, PrReference } from '../src/api/types';

const prRef: PrReference = { owner: 'o', repo: 'r', number: 1 };
const file = {
  path: 'a.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      body: '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;',
    },
  ],
} as unknown as FileChange;

describe('DiffPane syntax highlighting', () => {
  it('renders .codeToken spans for context/solo lines', async () => {
    await getHighlighterAsync();
    const { container } = render(
      <DiffPane
        prRef={prRef}
        selectedPath="a.ts"
        file={file}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        headSha="h"
        baseSha="b"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.codeToken')).not.toBeNull();
    });
    // single wrapper per content cell
    const cells = container.querySelectorAll('.diff-content .codeLine');
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach((c) =>
      expect(c.parentElement!.querySelectorAll(':scope > .codeLine').length).toBe(1),
    );
  });
});
