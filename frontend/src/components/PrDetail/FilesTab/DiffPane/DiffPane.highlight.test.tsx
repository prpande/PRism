import { render, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffPane } from './DiffPane';
import { getHighlighterAsync } from '../../../Markdown/shikiInstance';
import type { FileChange, PrReference } from '../../../../api/types';

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

  it('renders .codeToken spans in split (side-by-side) mode', async () => {
    await getHighlighterAsync();
    const { container } = render(
      <DiffPane
        prRef={prRef}
        selectedPath="a.ts"
        file={file}
        diffMode="side-by-side"
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
    // every content cell still has exactly one .codeLine wrapper
    const cells = container.querySelectorAll('.diff-content .codeLine');
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach((c) =>
      expect(c.parentElement!.querySelectorAll(':scope > .codeLine').length).toBe(1),
    );
  });

  it('layers token color and background-only word-diff on paired lines', async () => {
    await getHighlighterAsync();
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
    await waitFor(() => expect(container.querySelector('.codeToken')).not.toBeNull());
    // a changed token carries both a syntax color var AND a background class
    expect(container.querySelector('.codeToken.wordDiffInsertBg')).not.toBeNull();
    // the paired delete row carries the delete-background class on its changed token
    expect(container.querySelector('.codeToken.wordDiffDeleteBg')).not.toBeNull();
  });

  it('does not show the large-file indicator for a normal small file', async () => {
    await getHighlighterAsync();
    const { container, queryByText } = render(
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
    await waitFor(() => expect(container.querySelector('.codeToken')).not.toBeNull());
    expect(queryByText(/Syntax highlighting off/)).toBeNull();
  });

  it('shows the large-file indicator when highlighting is suppressed by size', async () => {
    await getHighlighterAsync();
    // Trip the byte guard (>200 KB) with few but very long lines, so the test
    // renders ~60 rows instead of 2000+ (keeps the jsdom render light enough to
    // not destabilize a parallel vitest worker).
    const longLine = ' ' + 'x'.repeat(3500); // leading space ⇒ context line
    const bigBody = '@@ -1,60 +1,60 @@\n' + Array.from({ length: 60 }, () => longLine).join('\n');
    const big = {
      path: 'a.ts',
      status: 'modified',
      hunks: [{ oldStart: 1, oldLines: 60, newStart: 1, newLines: 60, body: bigBody }],
    } as unknown as FileChange;
    const { container, queryByText } = render(
      <DiffPane
        prRef={prRef}
        selectedPath="a.ts"
        file={big}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        headSha="h"
        baseSha="b"
      />,
    );
    await waitFor(() =>
      expect(queryByText(/Syntax highlighting off \(large file\)/)).not.toBeNull(),
    );
    // suppressed → no syntax tokens emitted
    expect(container.querySelector('.codeToken')).toBeNull();
  });
});
