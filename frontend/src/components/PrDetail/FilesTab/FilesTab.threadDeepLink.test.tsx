import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilesTab } from './FilesTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { PrDetailContextValue } from '../prDetailContext';
import { makePrDetailDto, makePr } from '../../../../__tests__/helpers/prDetail';
import { makePrDetailContextValue } from '../testUtils';
import type { DiffDto, FileChange, ReviewThreadDto } from '../../../api/types';
import type { UseFileDiffResult } from '../../../hooks/useFileDiff';
import type { UseDraftSessionResult } from '../../../hooks/useDraftSession';

const BASE_SHA = 'basesha';
const HEAD_SHA = 'headsha';
const DIFF_RANGE = `${BASE_SHA}..${HEAD_SHA}`;

const OTHER: FileChange = {
  path: 'other.cs',
  status: 'modified',
  hunks: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1 +1 @@\n-old\n+new\n' },
  ],
};
const TARGET: FileChange = {
  path: 'target.cs',
  status: 'modified',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1 +1 @@\n-x\n+y\n' }],
};

// A settled full-range diff containing both files — 'other.cs' sorts first
// alphabetically (treeBuilder), so it is the tab's auto-select fallback while
// 'target.cs' is the thread deep-link's target.
const FULL: DiffDto = { range: DIFF_RANGE, files: [OTHER, TARGET], truncated: false };

let currentDiff: UseFileDiffResult;

vi.mock('../../../hooks/useFileDiff', () => ({
  useFileDiff: () => currentDiff,
}));
vi.mock('../../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => currentDiff,
}));
vi.mock('../../../hooks/useAiHunkAnnotations', () => ({
  useAiHunkAnnotations: () => ({ state: 'empty', annotations: null }),
}));
vi.mock('../../../hooks/useWholeFileContent', () => ({
  useWholeFileContent: () => ({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  }),
}));
vi.mock('../../../api/fileViewed', () => ({
  postFileViewed: vi.fn().mockResolvedValue(undefined),
}));

// Stand-in for DiffPane (Task 10, #774). The pending-thread effect under test
// only cares about DiffPane's DOM CONTRACT — a `.diff-pane-body` scroll
// container plus each thread widget's `data-thread-id` attribute, plain
// `comment-thread` global class, and focusability — exactly as
// ExistingCommentWidget's ThreadView renders them
// (DiffPane/ExistingCommentWidget.tsx:189-195). The real DiffPane's hunk/line
// matching machinery is irrelevant here. `reviewThreads` arrives PRE-FILTERED
// to the selected file (FilesTab computes `fileThreads` before passing it
// down), so the stand-in renders one widget per entry, unconditionally.
vi.mock('./DiffPane', () => ({
  DiffPane: ({ reviewThreads }: { reviewThreads: ReviewThreadDto[] }) => (
    <div className="diff-pane-body" data-testid="stand-in-diff-pane-body">
      {reviewThreads.map((t) => (
        <div key={t.threadId} tabIndex={-1} className="comment-thread" data-thread-id={t.threadId}>
          {t.threadId}
        </div>
      ))}
    </div>
  ),
}));

function makeThread(overrides: Partial<ReviewThreadDto> = {}): ReviewThreadDto {
  return {
    threadId: 'seed-anchored',
    filePath: 'target.cs',
    lineNumber: 1,
    isResolved: false,
    comments: [
      {
        commentId: 'c1',
        author: 'reviewer',
        createdAt: '2026-05-01T00:00:00Z',
        body: 'looks good',
        editedAt: null,
      },
    ],
    ...overrides,
  };
}

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
    removeDraftLocally: vi.fn(),
    insertDraftLocally: vi.fn(),
  };
}

function makeContextValue(overrides: Partial<PrDetailContextValue> = {}): PrDetailContextValue {
  return makePrDetailContextValue({
    prRef: { owner: 'octocat', repo: 'hello', number: 42 },
    prDetail: makePrDetailDto({
      pr: makePr({ headSha: HEAD_SHA, baseSha: BASE_SHA, htmlUrl: 'https://example.com/pr/42' }),
      reviewComments: [makeThread()],
    }),
    draftSession: makeDraftSession(),
    ...overrides,
  });
}

const getRow = (path: string) =>
  screen.getAllByTestId('files-tab-tree-row').find((r) => r.getAttribute('data-path') === path);

describe('FilesTab thread deep-link (#774)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls, focuses, and flashes the target thread once the diff settles', async () => {
    const clearPendingFilePath = vi.fn();
    const clearPendingThread = vi.fn();
    // In-flight first: both the file-select effect and the thread effect must
    // wait, and — critically — no widget has mounted yet. That lets us stub
    // scrollTo on the still-empty `.diff-pane-body` before the settled
    // rerender mounts the widget and the hit branch calls it.
    currentDiff = { data: null, isLoading: true, showSkeleton: true, error: null };
    const value = makeContextValue({
      pendingFilePath: 'target.cs',
      pendingThread: { path: 'target.cs', threadId: 'seed-anchored' },
      clearPendingFilePath,
      clearPendingThread,
    });

    const { rerender } = render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    const body = screen.getByTestId('stand-in-diff-pane-body');
    (body as unknown as { scrollTo: () => void }).scrollTo = vi.fn();

    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    rerender(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    const diffRegion = screen.getByTestId('files-tab-diff');
    const widget = await waitFor(() => {
      const el = diffRegion.querySelector<HTMLElement>('[data-thread-id="seed-anchored"]');
      expect(el).not.toBeNull();
      expect(el).toHaveClass('comment-thread--flash');
      return el as HTMLElement;
    });

    expect(document.activeElement).toBe(widget);
    expect(clearPendingThread).toHaveBeenCalled();
    expect(screen.getByTestId('files-tab-live-region')).toHaveTextContent(/comment thread/i);
  });

  it('shows the not-found snackbar when the thread is absent from the diff', async () => {
    const clearPendingFilePath = vi.fn();
    const clearPendingThread = vi.fn();
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    // Same target path as the seeded thread, but an id no widget carries.
    const value = makeContextValue({
      pendingFilePath: 'target.cs',
      pendingThread: { path: 'target.cs', threadId: 'ghost-thread' },
      clearPendingFilePath,
      clearPendingThread,
    });

    render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // The live region and the Snackbar carry the SAME message text (the
    // Snackbar itself has no aria-live, matching GitHubAuthBanner) — scope to
    // the Snackbar's dismiss button to disambiguate from the sr-only region.
    const dismissButton = await screen.findByRole('button', { name: 'Dismiss' });
    expect(dismissButton.closest('div')).toHaveTextContent(
      'Comment thread not found in the current diff.',
    );
    expect(screen.getByTestId('files-tab-live-region')).toHaveTextContent(/not found/i);
    expect(clearPendingThread).toHaveBeenCalled();
  });

  it('does not fire (no miss, no clear) until the target file is the selected file', async () => {
    const clearPendingThread = vi.fn();
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    // No pendingFilePath — the tab's own auto-select seizes fileList[0]
    // ('other.cs', alphabetically first), a DIFFERENT file from the pending
    // thread's target ('target.cs').
    const value = makeContextValue({
      pendingFilePath: null,
      pendingThread: { path: 'target.cs', threadId: 'seed-anchored' },
      clearPendingThread,
    });

    render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    await waitFor(() => {
      expect(getRow('other.cs')).toHaveAttribute('data-selected', 'true');
    });

    expect(
      screen.queryByText('Comment thread not found in the current diff.'),
    ).not.toBeInTheDocument();
    expect(clearPendingThread).not.toHaveBeenCalled();
  });

  it('leaves single-arg file navigation unchanged (diff region focused, no thread effect)', async () => {
    const clearPendingFilePath = vi.fn();
    const clearPendingThread = vi.fn();
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    const value = makeContextValue({
      pendingFilePath: 'target.cs',
      pendingThread: null,
      clearPendingFilePath,
      clearPendingThread,
    });

    render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    const diffRegion = screen.getByTestId('files-tab-diff');
    await waitFor(() => {
      expect(document.activeElement).toBe(diffRegion);
    });
    expect(screen.getByTestId('files-tab-live-region')).toHaveTextContent('target.cs');
    expect(
      screen.queryByText('Comment thread not found in the current diff.'),
    ).not.toBeInTheDocument();
    expect(clearPendingThread).not.toHaveBeenCalled();
  });

  it('clears the pending thread without a miss snackbar when the diff fails to load', async () => {
    const clearPendingFilePath = vi.fn();
    const clearPendingThread = vi.fn();
    // 1st render: settle successfully on the target file (no pendingThread
    // yet) so selectedPath is already 'target.cs' when the thread intent
    // arrives — otherwise the wrong-file guard would mask the error path.
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    const value = makeContextValue({
      pendingFilePath: 'target.cs',
      pendingThread: null,
      clearPendingFilePath,
      clearPendingThread,
    });

    const { rerender } = render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    await waitFor(() => {
      expect(getRow('target.cs')).toHaveAttribute('data-selected', 'true');
    });

    // 2nd render: the thread intent arrives while the diff now fails to load.
    currentDiff = { data: null, isLoading: false, showSkeleton: false, error: new Error('boom') };
    const erroredValue: PrDetailContextValue = {
      ...value,
      pendingFilePath: null,
      pendingThread: { path: 'target.cs', threadId: 'seed-anchored' },
    };
    rerender(
      <PrDetailContextProvider value={erroredValue}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    await waitFor(() => {
      expect(clearPendingThread).toHaveBeenCalled();
    });
    expect(
      screen.queryByText('Comment thread not found in the current diff.'),
    ).not.toBeInTheDocument();
  });

  it('clears a stale not-found snackbar once a later pending thread hits (M1)', async () => {
    const clearPendingFilePath = vi.fn();
    const clearPendingThread = vi.fn();
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    // 1st pending thread: target file, but an id no widget carries — misses,
    // leaving the not-found Snackbar up (Snackbar has no auto-dismiss).
    const missValue = makeContextValue({
      pendingFilePath: 'target.cs',
      pendingThread: { path: 'target.cs', threadId: 'ghost-thread' },
      clearPendingFilePath,
      clearPendingThread,
    });

    const { rerender } = render(
      <PrDetailContextProvider value={missValue}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // jsdom has no scrollTo; the 'seed-anchored' widget for the SECOND
    // (hit) pending thread is already mounted in the DOM during this first
    // render (the DiffPane stand-in renders all of fileThreads, not just
    // the pending one), so stub it now before that later hit fires.
    const body = screen.getByTestId('stand-in-diff-pane-body');
    (body as unknown as { scrollTo: () => void }).scrollTo = vi.fn();

    const dismissButton = await screen.findByRole('button', { name: 'Dismiss' });
    expect(dismissButton.closest('div')).toHaveTextContent(
      'Comment thread not found in the current diff.',
    );

    // 2nd pending thread: same target file, an id whose widget IS present — a
    // later successful jump must clear the stale miss Snackbar (M1 fix).
    const hitValue: PrDetailContextValue = {
      ...missValue,
      pendingFilePath: null,
      pendingThread: { path: 'target.cs', threadId: 'seed-anchored' },
    };
    rerender(
      <PrDetailContextProvider value={hitValue}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    const diffRegion = screen.getByTestId('files-tab-diff');
    await waitFor(() => {
      const el = diffRegion.querySelector<HTMLElement>('[data-thread-id="seed-anchored"]');
      expect(el).toHaveClass('comment-thread--flash');
    });

    expect(
      screen.queryByText('Comment thread not found in the current diff.'),
    ).not.toBeInTheDocument();
  });
});
