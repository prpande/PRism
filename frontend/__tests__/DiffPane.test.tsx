import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffPane } from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane';
import type { FileChange, ReviewThreadDto, PrReference } from '../src/api/types';
import { useAiGate } from '../src/hooks/useAiGate';
import { useAiHunkAnnotations } from '../src/hooks/useAiHunkAnnotations';

vi.mock('../src/hooks/useAiGate');
vi.mock('../src/hooks/useAiHunkAnnotations');

const samplePrRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const hunkBody = `@@ -1,3 +1,4 @@
 line one
-line two
+line two modified
+line three new
 line four
`;

const sampleFile: FileChange = {
  path: 'src/main.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      body: hunkBody,
    },
  ],
};

const emptyFile: FileChange = {
  path: 'src/empty.ts',
  status: 'added',
  hunks: [],
};

const sampleThread: ReviewThreadDto = {
  threadId: 'thread-1',
  filePath: 'src/main.ts',
  lineNumber: 2,
  anchorSha: 'abc123',
  isResolved: false,
  comments: [
    {
      commentId: 'c1',
      author: 'alice',
      createdAt: '2026-05-01T10:00:00Z',
      body: 'Please fix this line.',
      editedAt: null,
    },
  ],
};

describe('DiffPane', () => {
  beforeEach(() => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiHunkAnnotations).mockReturnValue(null);
  });

  it('renders empty state when no file is selected', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath={null}
        file={null}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it('renders file path in header when file selected', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
  });

  it('renders diff lines from hunk body', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const insertRows = diffPane.querySelectorAll('.diff-line--insert');
    expect(insertRows.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/line three new/)).toBeInTheDocument();
  });

  it('renders truncation banner when truncated', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={true}
        reviewThreads={[]}
        prUrl="https://github.com/octocat/hello/pull/42"
      />,
    );
    expect(screen.getByText(/open on github\.com/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open on github\.com/i });
    expect(link.getAttribute('href')).toBe('https://github.com/octocat/hello/pull/42');
  });

  it('does not render truncation banner when not truncated', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    expect(screen.queryByText(/open on github\.com/i)).not.toBeInTheDocument();
  });

  it('renders comment widget for matching thread', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[sampleThread]}
        prUrl=""
      />,
    );
    const commentWidgets = screen.getAllByTestId('comment-widget');
    expect(commentWidgets.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Please fix this line.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('alice').length).toBeGreaterThanOrEqual(1);
  });

  it('renders empty file state for file with no hunks', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/empty.ts"
        file={emptyFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    expect(screen.getByText(/empty file/i)).toBeInTheDocument();
  });

  it('renders side-by-side layout when diffMode is side-by-side', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--split');
  });

  it('renders unified layout when diffMode is unified', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--unified');
  });

  it('uses colSpan=4 for full-width rows in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[sampleThread]}
        prUrl=""
      />,
    );
    const widgetRows = screen
      .getAllByTestId('comment-widget')
      .map((widget) => widget.closest('tr'))
      .filter((tr): tr is HTMLTableRowElement => tr !== null);
    expect(widgetRows.length).toBeGreaterThanOrEqual(1);
    widgetRows.forEach((row) => {
      const cell = row.querySelector('td');
      expect(cell?.getAttribute('colSpan') ?? cell?.getAttribute('colspan')).toBe('4');
    });
  });

  it('uses colSpan=3 for full-width rows in unified mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[sampleThread]}
        prUrl=""
      />,
    );
    const widgetRows = screen
      .getAllByTestId('comment-widget')
      .map((widget) => widget.closest('tr'))
      .filter((tr): tr is HTMLTableRowElement => tr !== null);
    expect(widgetRows.length).toBeGreaterThanOrEqual(1);
    widgetRows.forEach((row) => {
      const cell = row.querySelector('td');
      expect(cell?.getAttribute('colSpan') ?? cell?.getAttribute('colspan')).toBe('3');
    });
  });
});
