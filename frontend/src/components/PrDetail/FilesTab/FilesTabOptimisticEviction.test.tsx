import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from './FilesTab';
import { OPTIMISTIC_FALLBACK_MAX_AGE_MS } from './optimisticComment';
import { PrDetailContextProvider } from '../prDetailContext';
import { __resetTabIdForTest } from '../../../api/draft';
import { useDraftSession } from '../../../hooks/useDraftSession';
import { makePrDetailDto, makePr } from '../../../../__tests__/helpers/prDetail';
import type {
  DiffDto,
  PrDetailDto,
  PrReference,
  ReviewSessionDto,
  ReviewThreadDto,
} from '../../../api/types';

// #603 item C — FULL FilesTab integration for the null-databaseId optimistic
// placeholder eviction. The pure predicate is unit-tested in
// optimisticComment.test.ts; this exercises the real component render + the real
// refetch-generation / one-shot-timer wiring end to end:
//
//   post-now → dimmed placeholder → refetch lands the just-posted comment with
//   databaseId: null (the databaseId fast-path can NEVER match) → age past the
//   bound → the placeholder is evicted, leaving exactly one (real) comment, not
//   the permanent visible duplicate the bug produced.
//
// Drives the composer with fireEvent (not userEvent) to stay clear of the known
// userEvent + fake-timers deadlock in this repo: the post + placeholder phase
// runs on real timers, and fake timers are switched on only to fire the bounded
// fallback timer deterministically (no 4s real-time wait).

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// Same one-file diff the existing FilesTab composer/highlight tests use. Line 1
// is the context row " function a() {" (new-side line 1), and a review thread
// anchored at line 1 renders its comment widget there (see
// DiffPane.threadHighlight.test.tsx).
const onefileDiff: DiffDto = {
  range: 'basedef..headabc',
  files: [
    {
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
    },
  ],
  truncated: false,
};

const POSTED_BODY = 'my new comment';
// makeRouteHandler's POST /comment/post returns this id; the optimistic
// placeholder's postedCommentId becomes 12345.
const POSTED_COMMENT_ID = 12345;

function basePrDetail(reviewComments: ReviewThreadDto[] = []): PrDetailDto {
  return makePrDetailDto({
    pr: makePr({ reference: ref, headSha: 'headabc', baseSha: 'basedef' }),
    iterations: [
      {
        number: 1,
        beforeSha: 'basedef',
        afterSha: 'headabc',
        commits: [],
        hasResolvableRange: true,
      },
    ],
    reviewComments,
  });
}

// A server thread for src/main.ts line 1 carrying the just-posted comment. The
// `databaseId` is parameterized: null models a real GitHub response (the bug
// trigger); a number models the databaseId fast-path.
function postedThread(databaseId: number | null): ReviewThreadDto {
  return {
    threadId: 'server-thread-1',
    filePath: 'src/main.ts',
    lineNumber: 1,
    isResolved: false,
    comments: [
      {
        commentId: 'real-c1',
        author: 'You',
        avatarUrl: null,
        createdAt: '2026-06-28T00:00:00Z',
        body: POSTED_BODY,
        editedAt: null,
        databaseId,
      },
    ],
  };
}

function emptySession(): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
  };
}

// A saved draft at src/main.ts line 1 so the composer mounts with a persisted
// draftId and the post-now "Comment" button is enabled (mirrors the existing
// inline optimistic-placeholder test in FilesTabComposer.test.tsx).
function sessionWithSavedDraft(): ReviewSessionDto {
  return {
    ...emptySession(),
    draftComments: [
      {
        id: 'uuid-existing',
        filePath: 'src/main.ts',
        lineNumber: 1,
        side: 'right',
        anchoredSha: 'a'.repeat(40),
        anchoredLineContent: ' function a() {',
        bodyMarkdown: POSTED_BODY,
        status: 'draft',
        isOverriddenStale: false,
        postedCommentId: null,
      },
    ],
  };
}

function makeRouteHandler(diff: DiffDto, session: ReviewSessionDto) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (typeof url === 'string') {
      if (url.includes('/diff')) {
        return Promise.resolve(
          new Response(JSON.stringify(diff), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/draft') && method === 'GET') {
        return Promise.resolve(
          new Response(JSON.stringify(session), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/comment/post') && method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ postedCommentId: POSTED_COMMENT_ID }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function Wrapper({ prDetail }: { prDetail: PrDetailDto }) {
  const draftSession = useDraftSession(ref);
  return (
    <PrDetailContextProvider
      value={{
        prRef: ref,
        prDetail,
        draftSession,
        readOnly: false,
        subscribed: false,
        baseShaChanged: false,
        onSelectSubTab: () => {},
        fileFocus: { status: 'no-changes', entries: [], retry: () => {} },
        checks: { status: 'idle', degraded: 'none', checks: [], retry: () => {} },
        pendingFilePath: null,
        pendingThread: null,
        requestFileView: () => {},
        clearPendingFilePath: () => {},
        clearPendingThread: () => {},
        viewedPaths: new Set(),
        toggleViewed: () => {},
        reload: () => {},
        isLoading: false,
        prUpdatedSignal: 0,
      }}
    >
      <Outlet />
    </PrDetailContextProvider>
  );
}

// Structurally-stable element tree so rerender(prDetail2) preserves FilesTab's
// internal state (the `optimistic` placeholders) across the simulated refetch —
// only the prDetail prop (and thus prDetail.reviewComments → allRealComments)
// changes, which is exactly what a real PrDetail refetch mutates.
function App({ prDetail }: { prDetail: PrDetailDto }) {
  return (
    <MemoryRouter initialEntries={['/pr/octocat/hello/42/files']}>
      <Routes>
        <Route path="/pr/:owner/:repo/:number" element={<Wrapper prDetail={prDetail} />}>
          <Route path="files/*" element={<FilesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

// Render, open the composer on line 1, and post — returning once the dimmed
// optimistic placeholder is on screen (on real timers).
async function renderAndPost(handler: ReturnType<typeof makeRouteHandler>) {
  globalThis.fetch = handler as unknown as typeof fetch;
  const view = render(<App prDetail={basePrDetail()} />);

  await waitFor(() => {
    fireEvent.click(screen.getByText('main.ts'));
  });

  fireEvent.click(await screen.findByRole('button', { name: 'Add comment on line 1' }));
  await screen.findByRole('form', { name: 'Draft comment on src/main.ts line 1' });

  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

  // The optimistic placeholder appears (dimmed) right where the composer was.
  const optimistic = await screen.findByTestId('inline-comment-card-optimistic');
  expect(optimistic).toHaveTextContent(POSTED_BODY);
  expect(optimistic.className).toContain('comment-card--posting');

  return view;
}

beforeEach(() => {
  __resetTabIdForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FilesTab — #603 item C null-databaseId optimistic placeholder eviction (integration)', () => {
  it('evicts the placeholder once a refetch lands the posted comment with databaseId: null and it ages past the bound (no permanent duplicate)', async () => {
    const handler = makeRouteHandler(onefileDiff, sessionWithSavedDraft());
    const { rerender } = await renderAndPost(handler);

    // Switch to fake timers only now (the post round-trip has settled on real
    // timers). The placeholder's createdAt was just captured from the real clock;
    // useFakeTimers seeds the fake clock at ~that same instant.
    vi.useFakeTimers();

    // The refetch lands: reviewComments now carries the just-posted comment, but
    // WITHOUT a databaseId (real GitHub responses ship databaseId: null) — the
    // fast-path can never match it. This bumps the refetch generation.
    act(() => {
      rerender(<App prDetail={basePrDetail([postedThread(null)])} />);
    });

    // Before the bound elapses, the bug's symptom is live: the dimmed placeholder
    // AND the real comment are both rendered — the visible duplicate.
    expect(screen.getByTestId('inline-comment-card-optimistic')).toBeInTheDocument();
    expect(screen.getByTestId('inline-comment-card')).toHaveTextContent(POSTED_BODY);

    // Age past the bounded fallback window → the one-shot prune timer fires.
    act(() => {
      vi.advanceTimersByTime(OPTIMISTIC_FALLBACK_MAX_AGE_MS + 1);
    });

    // The placeholder is evicted; exactly one (real) comment remains.
    expect(screen.queryByTestId('inline-comment-card-optimistic')).not.toBeInTheDocument();
    const realCards = screen.getAllByTestId('inline-comment-card');
    expect(realCards).toHaveLength(1);
    expect(realCards[0]).toHaveTextContent(POSTED_BODY);
  });

  it('evicts the placeholder immediately via the databaseId fast-path when the refetched comment carries a matching databaseId (no aging needed)', async () => {
    const handler = makeRouteHandler(onefileDiff, sessionWithSavedDraft());
    const { rerender } = await renderAndPost(handler);

    // The refetch lands the posted comment WITH the matching databaseId — the
    // fast-path drops the placeholder at once, no time advance required.
    rerender(<App prDetail={basePrDetail([postedThread(POSTED_COMMENT_ID)])} />);

    await waitFor(() =>
      expect(screen.queryByTestId('inline-comment-card-optimistic')).not.toBeInTheDocument(),
    );
    const realCards = screen.getAllByTestId('inline-comment-card');
    expect(realCards).toHaveLength(1);
    expect(realCards[0]).toHaveTextContent(POSTED_BODY);
  });
});
