import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffPane } from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane';
import type { FileChange, ReviewThreadDto, PrReference } from '../src/api/types';
import type { DiffMode } from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane';
import { useAiGate } from '../src/hooks/useAiGate';
import { useAiHunkAnnotations } from '../src/hooks/useAiHunkAnnotations';
import { useWholeFileContent } from '../src/hooks/useWholeFileContent';
import styles from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css';

vi.mock('../src/hooks/useAiGate');
vi.mock('../src/hooks/useAiHunkAnnotations');
vi.mock('../src/hooks/useWholeFileContent');

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
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
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

  it('renders hunk-header as a single colSpan=4 row in split mode', () => {
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
    const diffPane = screen.getByTestId('diff-pane');
    const hunkHeaderRows = diffPane.querySelectorAll('tr.diff-line--hunk-header');
    expect(hunkHeaderRows.length).toBeGreaterThanOrEqual(1);
    hunkHeaderRows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      expect(cells.length).toBe(1);
      const cell = cells[0];
      expect(cell.getAttribute('colSpan') ?? cell.getAttribute('colspan')).toBe('4');
      expect(cell.textContent).toMatch(/@@/);
    });
  });

  it('renders context line with both gutters and same content on both sides in split mode', () => {
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
    const diffPane = screen.getByTestId('diff-pane');
    const contextRows = diffPane.querySelectorAll('tr.diff-line--context');
    expect(contextRows.length).toBeGreaterThanOrEqual(1);
    const firstContext = contextRows[0];
    const cells = firstContext.querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toMatch(/\d+/); // old line number
    expect(cells[2].textContent).toMatch(/\d+/); // new line number
    expect(cells[1].textContent).toBe(cells[3].textContent); // same content both sides
    expect(cells[1].textContent).not.toBe('');
  });

  it('renders AI annotation row with colSpan=4 in split mode', () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useAiHunkAnnotations).mockReturnValue([
      {
        path: 'src/main.ts',
        hunkIndex: 0,
        body: 'Consider naming this clearer.',
        tone: 'calm',
      },
    ]);
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
    const annotationCell = screen.getByTestId('ai-hunk-annotation').closest('td');
    expect(annotationCell).not.toBeNull();
    expect(annotationCell?.getAttribute('colSpan') ?? annotationCell?.getAttribute('colspan')).toBe(
      '4',
    );
  });

  it('renders solo-delete row with right cells aria-hidden and row aria-label', () => {
    const soloDeleteHunk = `@@ -1,2 +1,1 @@
-line removed
 line kept
`;
    const soloFile: FileChange = {
      path: 'src/solo.ts',
      status: 'modified',
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, body: soloDeleteHunk }],
    };
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/solo.ts"
        file={soloFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const deleteRows = diffPane.querySelectorAll('tr.diff-line--delete');
    expect(deleteRows.length).toBe(1);
    expect(deleteRows[0].getAttribute('aria-label')).toBe('Removed line 1');
    const cells = deleteRows[0].querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe('1');
    expect(cells[1].textContent).toContain('line removed');
    expect(cells[2].getAttribute('aria-hidden')).toBe('true');
    expect(cells[2].className).toContain('diffCellEmpty');
    expect(cells[3].getAttribute('aria-hidden')).toBe('true');
    expect(cells[3].className).toContain('diffCellEmpty');
    expect(deleteRows[0].querySelectorAll('.diff-comment-affordance').length).toBe(0);
  });

  it('renders solo-insert row with left cells aria-hidden, affordance on right, row aria-label', () => {
    const soloInsertHunk = `@@ -1,1 +1,2 @@
 line kept
+line added
`;
    const soloFile: FileChange = {
      path: 'src/solo.ts',
      status: 'modified',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body: soloInsertHunk }],
    };
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/solo.ts"
        file={soloFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        onLineClick={() => {}}
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const insertRows = diffPane.querySelectorAll('tr.diff-line--insert');
    expect(insertRows.length).toBe(1);
    expect(insertRows[0].getAttribute('aria-label')).toBe('Added line 2');
    const cells = insertRows[0].querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].getAttribute('aria-hidden')).toBe('true');
    expect(cells[0].className).toContain('diffCellEmpty');
    expect(cells[1].getAttribute('aria-hidden')).toBe('true');
    expect(cells[1].className).toContain('diffCellEmpty');
    expect(cells[2].textContent).toContain('2');
    expect(cells[3].textContent).toContain('line added');
    expect(insertRows[0].querySelectorAll('.diff-comment-affordance').length).toBe(1);
  });

  it('renders paired modification as a single row with WordDiffOverlay on both sides in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        onLineClick={() => {}}
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const pairedRows = diffPane.querySelectorAll('tr.diff-line--paired');
    expect(pairedRows.length).toBe(1);
    const pairedRow = pairedRows[0];
    const cells = pairedRow.querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toMatch(/\d+/);
    expect(cells[2].textContent).toMatch(/\d+/);
    const overlays = pairedRow.querySelectorAll('[data-testid="word-diff-overlay"]');
    expect(overlays.length).toBe(2);
    expect(pairedRow.querySelectorAll('.diff-comment-affordance').length).toBe(1);
  });

  it('attaches comment widget to paired row in split mode (anchored to next.newLineNum)', () => {
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
    const widget = screen.getByTestId('comment-widget');
    const widgetRow = widget.closest('tr');
    expect(widgetRow).not.toBeNull();
    const prevRow = widgetRow?.previousElementSibling;
    expect(prevRow?.className).toContain('diff-line--paired');
  });

  it('clicking the affordance on a paired row produces an InlineAnchor with the right-side newLineNum', () => {
    const onLineClick = vi.fn();
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        onLineClick={onLineClick}
      />,
    );
    const pairedRow = screen.getByTestId('diff-pane').querySelector('tr.diff-line--paired')!;
    const affordance = pairedRow.querySelector(
      'button.diff-comment-affordance',
    ) as HTMLButtonElement;
    affordance.click();
    expect(onLineClick).toHaveBeenCalledTimes(1);
    const anchor = onLineClick.mock.calls[0][0];
    expect(anchor.side).toBe('right');
    // sampleFile's paired row is `-line two` followed by `+line two modified`,
    // and parseHunkLines assigns newLineNum=2 to the insert.
    expect(anchor.lineNumber).toBe(2);
  });

  it('emits a colgroup with 4 col elements in split mode', () => {
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
    const diffPane = screen.getByTestId('diff-pane');
    const colgroup = diffPane.querySelector('colgroup');
    expect(colgroup).not.toBeNull();
    expect(colgroup?.querySelectorAll('col').length).toBe(4);
  });

  it('does not emit a colgroup in unified mode', () => {
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
    const colgroup = diffPane.querySelector('colgroup');
    expect(colgroup).toBeNull();
  });
});

function makeModifiedFile(hunks: FileChange['hunks']): FileChange {
  return { path: 'src/a.ts', status: 'modified', hunks };
}

describe('DiffPane whole-file mode', () => {
  const defaultProps = {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    selectedPath: 'src/a.ts',
    file: makeModifiedFile([]),
    diffMode: 'unified' as DiffMode,
    truncated: false,
    reviewThreads: [],
    prUrl: 'https://example.com/pr/1',
  };

  beforeEach(() => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiHunkAnnotations).mockReturnValue(null);
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
  });

  it('renders filled-context rows with data-fill="true" when wholeFileEnabled and fetch ok (unified)', async () => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'ok',
      headContent: 'line1\nline2\nline3\nline4',
      baseContent: null,
      failureReason: null,
    });
    const file = makeModifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: '@@ -2,1 +2,1 @@\n-old\n+line2' },
    ]);
    const { container } = render(
      <DiffPane {...defaultProps} file={file} diffMode="unified" wholeFileEnabled={true} />,
    );
    const filledTrs = container.querySelectorAll('tr[data-fill="true"]');
    expect(filledTrs.length).toBeGreaterThan(0);
    const hunkHeaders = container.querySelectorAll('.diff-line--hunk-header');
    expect(hunkHeaders.length).toBe(0);
  });

  it('renders filled-context rows in split mode (4-column layout)', async () => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'ok',
      headContent: 'line1\nline2\nline3',
      baseContent: 'line1\nold\nline3',
      failureReason: null,
    });
    const file = makeModifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: '@@ -2,1 +2,1 @@\n-old\n+line2' },
    ]);
    const { container } = render(
      <DiffPane {...defaultProps} file={file} diffMode="side-by-side" wholeFileEnabled={true} />,
    );
    const filledTrs = container.querySelectorAll('tr[data-fill="true"]');
    expect(filledTrs.length).toBeGreaterThan(0);
    filledTrs.forEach((tr) => {
      expect(tr.querySelectorAll('td').length).toBe(4);
    });
  });

  it('renders failure banner and fires onWholeFileFailed once on transition; dismiss clears banner with the correct reason', async () => {
    const onFailed = vi.fn();
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'failed',
      headContent: null,
      baseContent: null,
      failureReason: 'file is too large to expand',
    });
    const fileWithHunk = makeModifiedFile([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-old\n+new' },
    ]);
    render(
      <DiffPane
        {...defaultProps}
        file={fileWithHunk}
        wholeFileEnabled={true}
        onWholeFileFailed={onFailed}
      />,
    );
    expect(await screen.findByTestId('whole-file-failure-banner')).toBeInTheDocument();
    expect(screen.getByText(/file is too large to expand/)).toBeInTheDocument();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('file is too large to expand');

    fireEvent.click(screen.getByRole('button', { name: /dismiss whole-file/i }));
    expect(screen.queryByTestId('whole-file-failure-banner')).not.toBeInTheDocument();
    // Dismiss only clears the local latch; it does NOT re-fire
    // onWholeFileFailed (Copilot iter-1 navigation race fix). The callback
    // was already invoked once on the original failure transition.
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('latch survives the toggle revert: banner stays visible when wholeFileEnabled flips false after a failure', async () => {
    const onFailed = vi.fn();
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'failed',
      headContent: null,
      baseContent: null,
      failureReason: 'file is binary',
    });
    const fileWithHunk = makeModifiedFile([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-old\n+new' },
    ]);
    const { rerender } = render(
      <DiffPane
        {...defaultProps}
        file={fileWithHunk}
        wholeFileEnabled={true}
        onWholeFileFailed={onFailed}
      />,
    );
    expect(await screen.findByTestId('whole-file-failure-banner')).toBeInTheDocument();
    expect(onFailed).toHaveBeenCalledTimes(1);

    // Simulate FilesTab removing the path from wholeFilePaths: rerender with
    // wholeFileEnabled=false and the hook now returning 'idle'.
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
    rerender(
      <DiffPane
        {...defaultProps}
        file={fileWithHunk}
        wholeFileEnabled={false}
        onWholeFileFailed={onFailed}
      />,
    );

    // Banner survives because DiffPane's local latch holds the reason.
    expect(screen.getByTestId('whole-file-failure-banner')).toBeInTheDocument();
    expect(screen.getByText(/file is binary/)).toBeInTheDocument();

    // Dismiss clears the latch.
    fireEvent.click(screen.getByRole('button', { name: /dismiss whole-file/i }));
    expect(screen.queryByTestId('whole-file-failure-banner')).not.toBeInTheDocument();
  });

  it('renders AI annotation row before the first non-header line of each hunk in whole-file mode', async () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'ok',
      headContent: 'a\nb\nc\nd',
      baseContent: null,
      failureReason: null,
    });
    vi.mocked(useAiHunkAnnotations).mockReturnValue([
      { path: 'src/a.ts', hunkIndex: 0, body: 'Annotation for hunk 0', tone: 'calm' },
    ]);
    const file = makeModifiedFile([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: '@@ -2,1 +2,1 @@\n-old\n+b' },
    ]);
    const { container } = render(
      <DiffPane {...defaultProps} file={file} diffMode="unified" wholeFileEnabled={true} />,
    );
    const annotationRow = container.querySelector(`.${styles.aiHunkRow}`);
    expect(annotationRow).toBeInTheDocument();
    const allRows = Array.from(container.querySelectorAll('tr'));
    const annotationIdx = allRows.indexOf(annotationRow as HTMLTableRowElement);
    expect(annotationIdx).toBeGreaterThanOrEqual(0);
    expect(allRows[annotationIdx + 1]?.classList.contains('diff-line--delete')).toBe(true);
  });
});
