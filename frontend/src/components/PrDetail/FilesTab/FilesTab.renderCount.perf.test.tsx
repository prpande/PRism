import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from './FilesTab';
import { PrDetailContextProvider } from '../prDetailContext';
import { __resetTabIdForTest } from '../../../api/draft';
import { useDraftSession } from '../../../hooks/useDraftSession';
import { makePrDetailDto, makePr } from '../../../../__tests__/helpers/prDetail';
import type {
  DiffDto,
  DraftCommentDto,
  DraftReplyDto,
  PrDetailDto,
  PrReference,
  ReviewSessionDto,
  ReviewThreadDto,
} from '../../../api/types';

// #327 Task 12 — FilesTab-level render-count guard for the composite
// `activeComposerKey` + stable `renderComposerForLine` mechanism (spec
// acceptance 3; delivers half of #688 item 2):
//
//   (a) typing in an open composer — spanning an autosave refetch — re-renders
//       ZERO DiffLineRow instances whose thread data is unchanged (row-level
//       memo bail, not merely body-level);
//   (b) INVERSE: clicking a line still mounts the composer row and closing
//       still unmounts it (guards the activeComposerKey channel against
//       staleness — and against a format mismatch between the key builder in
//       FilesTab and the per-row normalization in UnifiedDiffBody, which would
//       silently defeat the whole mechanism);
//   (c) reply-path INVERSE: an `optimisticByThread` change (posting a reply)
//       surfaces in the affected ExistingCommentWidget;
//   (c2) #327 Task 13 — a draft reply arriving via an autosave refetch
//       (cross-tab hydration) surfaces in the affected thread's widget through
//       the REACTIVE ReplyDataContext channel (a ref-read channel would stay
//       stale here), while (a)-style row bail still holds for unrelated
//       DiffLineRows (the replyContext prop is now the STABLE callbacks bag,
//       so draft-array churn never reaches the memoized rows).

// Count HighlightedLine renders without source instrumentation (same harness
// pattern as DiffPane.rowMemo.perf.test.tsx): a DiffLineRow that bails
// (React.memo) never re-invokes renderContent(), so its HighlightedLine child
// is never re-invoked. Context rows render HighlightedLine DIRECTLY in the
// row body (not via the memoized MergedPairedContent), so the counter is a
// ROW-level probe: any DiffLineRow re-render of a context row increments it.
const hl = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../Markdown/HighlightedLine', () => ({
  HighlightedLine: () => {
    hl.count += 1;
    return null;
  },
}));

// Pin syntax to a stable, ready, empty map: no async token-arrival re-render to
// pollute the count, and a single `syntax` identity across renders (which the
// real useSyntaxTokens also guarantees via its useMemo'd EMPTY sentinel).
vi.mock('../../../hooks/useSyntaxTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useSyntaxTokens')>();
  const EMPTY = { oldLineTokens: new Map(), newLineTokens: new Map(), ready: true } as const;
  return { ...actual, useSyntaxTokens: () => EMPTY };
});

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// One modified file. Unified rows: hunk-header, context (line 1), a
// delete+insert pair (line 2), context (line 3). The two context rows are the
// row-level HighlightedLine probes.
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

// A review thread anchored at line 3 (the trailing context row) — the
// "unchanged thread data" whose row must bail in (a) and whose widget must
// reflect the optimistic reply in (c).
const threadAtLine3: ReviewThreadDto = {
  threadId: 't3',
  filePath: 'src/main.ts',
  lineNumber: 3,
  anchorSha: 'headabc',
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

const prDetailWithThread: PrDetailDto = makePrDetailDto({
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
  reviewComments: [threadAtLine3],
});

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

const SEED_BODY = 'seed body';

// A saved draft at src/main.ts line 1 so the composer hydrates with a
// persisted draftId and typing takes the updateDraftComment autosave path.
function sessionWithSavedDraft(): ReviewSessionDto {
  const draft: DraftCommentDto = {
    id: 'uuid-existing',
    filePath: 'src/main.ts',
    lineNumber: 1,
    side: 'right',
    anchoredSha: 'a'.repeat(40),
    anchoredLineContent: ' function a() {',
    bodyMarkdown: SEED_BODY,
    status: 'draft',
    isOverriddenStale: false,
    postedCommentId: null,
  };
  return { ...emptySession(), draftComments: [draft] };
}

const REPLY_BODY = 'a drafted reply';

// A saved draft REPLY against thread t3 so ThreadView auto-mounts its
// ReplyComposer with a persisted draftId (post-now "Comment" enabled).
function sessionWithDraftReply(): ReviewSessionDto {
  const reply: DraftReplyDto = {
    id: 'uuid-reply',
    parentThreadId: 't3',
    replyCommentId: null,
    bodyMarkdown: REPLY_BODY,
    status: 'draft',
    isOverriddenStale: false,
  };
  return { ...emptySession(), draftReplies: [reply] };
}

const POSTED_COMMENT_ID = 777;

// `session` accepts a getter so (c2) can swap the served session mid-test
// (simulating a cross-tab draft arrival surfaced by the next GET /draft).
function makeRouteHandler(diff: DiffDto, session: ReviewSessionDto | (() => ReviewSessionDto)) {
  const sessionOf = () => (typeof session === 'function' ? session() : session);
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const json = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (typeof url === 'string') {
      if (url.includes('/diff')) return json(diff);
      if (url.endsWith('/draft') && method === 'GET') return json(sessionOf());
      if (url.endsWith('/draft') && method === 'PUT') return json({});
      if (url.endsWith('/comment/post') && method === 'POST') {
        return json({ postedCommentId: POSTED_COMMENT_ID });
      }
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function countGetDraft(handler: ReturnType<typeof makeRouteHandler>): number {
  return handler.mock.calls.filter((call: unknown[]) => {
    const u = call[0];
    const init = call[1] as RequestInit | undefined;
    return typeof u === 'string' && u.endsWith('/draft') && (init?.method ?? 'GET') === 'GET';
  }).length;
}

// Render-count probe: every Wrapper render rebuilds the context `value`
// object, so each Wrapper render re-renders FilesTab through the context.
// Assertion (a) uses this to prove the autosave refetch really re-rendered
// the tree — otherwise its "zero row re-renders" would be vacuous.
const wrapperRenders = { count: 0 };

function Wrapper({ prDetail }: { prDetail: PrDetailDto }) {
  wrapperRenders.count += 1;
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
        requestFileView: () => {},
        clearPendingFilePath: () => {},
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

async function selectFileUnified() {
  await waitFor(() => {
    fireEvent.click(screen.getByText('main.ts'));
  });
  // jsdom's 1024px innerWidth makes split the default; the row-level
  // activeComposerKey mechanism under test lives in unified mode.
  fireEvent.click(screen.getByTestId('diff-view-unified'));
}

beforeEach(() => {
  __resetTabIdForTest();
  hl.count = 0;
  wrapperRenders.count = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilesTab render-count guard — activeComposerKey + stable renderComposerForLine (#327 Task 12)', () => {
  it('(a) typing across an autosave refetch re-renders zero DiffLineRows with unchanged thread data', async () => {
    const handler = makeRouteHandler(onefileDiff, sessionWithSavedDraft());
    globalThis.fetch = handler as unknown as typeof fetch;
    render(<App prDetail={prDetailWithThread} />);
    await selectFileUnified();

    // Open the composer at line 1; it hydrates from the saved draft.
    fireEvent.click(await screen.findByRole('button', { name: 'Add comment on line 1' }));
    const textarea = (await screen.findByLabelText('Comment body')) as HTMLTextAreaElement;
    expect(textarea.value).toBe(SEED_BODY);

    // Let the open-composer render (key change: rows legitimately re-render)
    // and any in-flight work settle before measuring.
    await act(async () => {});
    hl.count = 0;
    const rendersBefore = wrapperRenders.count;
    const getDraftBefore = countGetDraft(handler);

    // Type → 250ms debounce autosave (updateDraftComment PUT) → onSaved →
    // draftSession.refetch() → GET /draft → setSession → tree re-render.
    fireEvent.change(textarea, { target: { value: `${SEED_BODY} — plus an edit` } });
    await waitFor(() => expect(countGetDraft(handler)).toBeGreaterThan(getDraftBefore));
    await act(async () => {}); // flush the post-refetch setSession render

    // Sanity: the refetch really re-rendered FilesTab (via the rebuilt context
    // value) — the zero below is measured across an actual re-render.
    expect(wrapperRenders.count).toBeGreaterThan(rendersBefore);
    // Row-level bail: no DiffLineRow with unchanged thread data re-rendered.
    expect(hl.count).toBe(0);
  });

  it('(b) inverse — clicking a line mounts the composer row; closing unmounts it', async () => {
    const handler = makeRouteHandler(onefileDiff, emptySession());
    globalThis.fetch = handler as unknown as typeof fetch;
    render(<App prDetail={prDetailWithThread} />);
    await selectFileUnified();

    // Mount: the click must reach the row through the memoized body — a stale
    // or format-mismatched activeComposerKey would leave every row bailed and
    // the composer would never appear.
    fireEvent.click(await screen.findByRole('button', { name: 'Add comment on line 1' }));
    await screen.findByRole('form', { name: 'Draft comment on src/main.ts line 1' });

    // Unmount: Discard with no persisted draft closes immediately. Assert
    // synchronously — before the close-refetch resolves — so the unmount is
    // attributable to the key change, not to the later replyContext churn.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(
      screen.queryByRole('form', { name: 'Draft comment on src/main.ts line 1' }),
    ).not.toBeInTheDocument();

    // Let the close-refetch settle before teardown.
    await act(async () => {});
  });

  it('(c) reply-path inverse — an optimisticByThread change surfaces in the affected ExistingCommentWidget', async () => {
    const handler = makeRouteHandler(onefileDiff, sessionWithDraftReply());
    globalThis.fetch = handler as unknown as typeof fetch;
    render(<App prDetail={prDetailWithThread} />);
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    // The saved draft reply auto-mounts the thread's ReplyComposer.
    await screen.findByTestId('reply-composer');

    // Post-now: POST /comment/post → onReplyPosted → noteReplyPosted →
    // optimisticByThread gains t3's placeholder → the widget must show it.
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const optimistic = await screen.findByTestId('inline-comment-card-optimistic');
    expect(optimistic).toHaveTextContent(REPLY_BODY);
    expect(optimistic.className).toContain('comment-card--posting');
  });

  it('(c2) a draft reply arriving via an autosave refetch surfaces in the affected thread widget while unrelated rows still bail (#327 Task 13)', async () => {
    // Served session starts WITHOUT a draft reply; the getter lets the test
    // swap it mid-flight to simulate a cross-tab arrival on the next refetch.
    let session = sessionWithSavedDraft();
    const handler = makeRouteHandler(onefileDiff, () => session);
    globalThis.fetch = handler as unknown as typeof fetch;
    render(<App prDetail={prDetailWithThread} />);
    await selectFileUnified();

    // Open the line-1 composer (hydrates from the saved draft) — its debounce
    // autosave is the refetch trigger we ride.
    fireEvent.click(await screen.findByRole('button', { name: 'Add comment on line 1' }));
    const textarea = (await screen.findByLabelText('Comment body')) as HTMLTextAreaElement;
    expect(textarea.value).toBe(SEED_BODY);

    // Thread t3 has no draft reply yet — no auto-mounted ReplyComposer.
    expect(screen.queryByTestId('reply-composer')).not.toBeInTheDocument();

    await act(async () => {});
    hl.count = 0;
    const rendersBefore = wrapperRenders.count;
    const getDraftBefore = countGetDraft(handler);

    // The cross-tab arrival: from now on GET /draft also returns t3's draft
    // reply (server-only entry — the diff-and-prefer merge adds it verbatim).
    session = { ...sessionWithSavedDraft(), draftReplies: sessionWithDraftReply().draftReplies };

    // Type → 250ms debounce autosave → onSaved → draftSession.refetch() →
    // the merged session gains t3's draft reply.
    fireEvent.change(textarea, { target: { value: `${SEED_BODY} — trigger refetch` } });
    await waitFor(() => expect(countGetDraft(handler)).toBeGreaterThan(getDraftBefore));

    // The affected thread's widget REFLECTS the arrival: useDraftBackedDisclosure
    // auto-mounts its ReplyComposer, pre-populated with the drafted body. This is
    // the reactivity half of the Task 13 contract — a ref-read data channel would
    // stay stale here and the composer would never appear.
    await screen.findByTestId('reply-composer');
    expect((screen.getByLabelText('Reply body') as HTMLTextAreaElement).value).toBe(REPLY_BODY);

    // Sanity: the refetch really re-rendered the tree.
    expect(wrapperRenders.count).toBeGreaterThan(rendersBefore);
    // The stability half: (a)-style row bail still holds — the draft-array
    // churn travelled ONLY through the reactive channel, never through the
    // rows' replyContext prop, so no DiffLineRow with unchanged thread and
    // composer data re-rendered.
    expect(hl.count).toBe(0);
  });
});
