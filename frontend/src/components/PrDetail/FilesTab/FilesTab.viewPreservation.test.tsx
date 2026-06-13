import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilesTab } from './FilesTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { PrDetailContextValue } from '../prDetailContext';
import { makePrDetailDto, makePr } from '../../../../__tests__/helpers/prDetail';
import { makePrDetailContextValue } from '../testUtils';
import type { DiffDto, FileChange, ReviewThreadDto } from '../../../api/types';
import type { UseDraftSessionResult } from '../../../hooks/useDraftSession';

// SHA constants kept coupled so the DIFF range and the makePr head/base SHAs
// (which FilesTab reconciles) cannot drift apart silently.
const BASE_SHA = 'basesha';
const HEAD_SHA = 'headsha';
const DIFF_RANGE = `${BASE_SHA}..${HEAD_SHA}`;

// FilesTab pulls its file set from the range-keyed diff hooks (NOT from
// context). Stub them to a deterministic 2-file diff so the tree + diff render
// without a backend. selectedPath / diffMode / viewedPaths are FilesTab's OWN
// useState — they are what this test proves survive a context (prDetail) swap.
const FILE_A: FileChange = {
  path: 'src/a.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      body: '@@ -1,2 +1,2 @@\n context a\n-old a\n+new a\n',
    },
  ],
};
const FILE_B: FileChange = {
  path: 'src/b.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      body: '@@ -1,2 +1,2 @@\n context b\n-old b\n+new b\n',
    },
  ],
};

const DIFF: DiffDto = { range: DIFF_RANGE, files: [FILE_A, FILE_B], truncated: false };

vi.mock('../../../hooks/useFileDiff', () => ({
  useFileDiff: () => ({ data: DIFF, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: DIFF, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../../hooks/useAiFileFocus', () => ({ useAiFileFocus: () => null }));
vi.mock('../../../hooks/useAiGate', () => ({ useAiGate: () => false }));
vi.mock('../../../hooks/useAiHunkAnnotations', () => ({ useAiHunkAnnotations: () => null }));
vi.mock('../../../hooks/useWholeFileContent', () => ({
  useWholeFileContent: () => ({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  }),
}));
// Marking a file viewed POSTs to the backend; on rejection FilesTab reverts the
// optimistic checkmark. Resolve so the viewed state we assert on stays put.
vi.mock('../../../api/fileViewed', () => ({
  postFileViewed: vi.fn().mockResolvedValue(undefined),
}));

// A realistic-enough draftSession: FilesTab builds its replyContext from these
// members, and replyContext is what lets ExistingCommentWidget render the
// per-thread Reply affordance. registerOpenComposer MUST be a function (its
// cleanup return is used in a ReplyComposer effect).
function makeDraftSession(): UseDraftSessionResult {
  return {
    session: {
      draftVerdict: null,
      draftVerdictStatus: 'draft',
      draftComments: [],
      draftReplies: [],
      iterationOverrides: [],
      pendingReviewId: null,
      pendingReviewCommitOid: null,
      fileViewState: { viewedFiles: {} },
    },
    status: 'ready',
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    registerOpenComposer: vi.fn().mockReturnValue(() => {}),
    getPrRootHolder: vi.fn().mockReturnValue(null),
    outOfBandToast: null,
    clearOutOfBandToast: vi.fn(),
    postingInProgress: false,
    beginPosting: vi.fn(),
    endPosting: vi.fn(),
  };
}

function makeContextValue(threads: ReviewThreadDto[]): PrDetailContextValue {
  return makePrDetailContextValue({
    prRef: { owner: 'octocat', repo: 'hello', number: 42 },
    prDetail: makePrDetailDto({
      pr: makePr({ headSha: HEAD_SHA, baseSha: BASE_SHA, htmlUrl: 'https://example.com/pr/42' }),
      reviewComments: threads,
    }),
    // A real callable draftSession — testUtils' default is a typed stub that
    // FilesTab would call into; override it with our complete fixture.
    draftSession: makeDraftSession(),
  });
}

// The just-arrived thread, anchored to FILE_B line 2 (the paired insert
// `+new b`, whose newLineNum is 2 per parseHunkLines). Carries a real threadId
// (→ ReplyComposer.parentThreadId) and one comment body.
const NEW_THREAD: ReviewThreadDto = {
  threadId: 'thread-new-1',
  filePath: 'src/b.ts',
  lineNumber: 2,
  anchorSha: 'headsha',
  isResolved: false,
  comments: [
    {
      commentId: 'c-new-1',
      author: 'reviewer',
      createdAt: '2026-06-12T10:00:00Z',
      body: 'Freshly posted comment that should be reply-able.',
      editedAt: null,
      databaseId: 9001,
    },
  ],
};

const getRow = (path: string) =>
  screen.getAllByTestId('files-tab-tree-row').find((r) => r.getAttribute('data-path') === path);

describe('FilesTab — view state survives a prDetail swap (auto-reload, #450)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps selected file, viewed state, and diff mode; surfaces the new thread with a reply affordance', async () => {
    const user = userEvent.setup();

    // 1. Render with a 2-file diff and ZERO review threads.
    const { rerender } = render(
      <PrDetailContextProvider value={makeContextValue([])}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // The first file (src/a.ts) auto-selects on mount.
    await waitFor(() => {
      expect(getRow('src/a.ts')).toHaveAttribute('data-selected', 'true');
    });

    // 2a. Select the SECOND file (src/b.ts).
    const rowB = getRow('src/b.ts');
    expect(rowB).toBeDefined();
    await user.click(rowB!);
    expect(getRow('src/b.ts')).toHaveAttribute('data-selected', 'true');

    // 2b. Toggle the SECOND file viewed (its checkbox in the fixed check column).
    const viewedB = screen.getByRole('checkbox', { name: 'Viewed src/b.ts' });
    await user.click(viewedB);
    expect(viewedB).toBeChecked();

    // 2c. Switch diff mode to unified (default is side-by-side at jsdom's
    // innerWidth >= 900). The rendered diff pane reflects effectiveDiffMode.
    expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--split');
    await user.click(screen.getByTestId('diff-view-unified'));
    expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--unified');

    // Sanity: no thread / reply affordance is present before the swap.
    expect(screen.queryByTestId('comment-widget')).not.toBeInTheDocument();

    // 3. Re-render the SAME FilesTab instance with a prDetail that ADDS one
    //    review thread, keeping the file-set + diff identical. This simulates
    //    usePrDetail.reload()'s data swap under keep-alive (no unmount).
    rerender(
      <PrDetailContextProvider value={makeContextValue([NEW_THREAD])}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // 4a. The SECOND file is still selected (component state survived the swap).
    expect(getRow('src/b.ts')).toHaveAttribute('data-selected', 'true');

    // 4b. Its viewed checkmark is still set.
    expect(screen.getByRole('checkbox', { name: 'Viewed src/b.ts' })).toBeChecked();

    // 4c. Diff mode is still unified.
    expect(screen.getByTestId('diff-pane')).toHaveClass('diff-pane--unified');

    // 4d. The new thread's comment body is now rendered.
    const widget = screen.getByTestId('comment-widget');
    expect(
      within(widget).getByText('Freshly posted comment that should be reply-able.'),
    ).toBeInTheDocument();

    // 4e. The new thread renders its REPLY affordance — the headline #450 proof:
    //     a posted comment is reply-able without a manual reload.
    expect(
      within(widget).getByRole('button', {
        name: 'Reply to thread on src/b.ts line 2',
      }),
    ).toBeInTheDocument();
  });
});
