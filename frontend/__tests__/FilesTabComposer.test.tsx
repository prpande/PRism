import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from '../src/components/PrDetail/FilesTab/FilesTab';
import { PrDetailContextProvider } from '../src/components/PrDetail/prDetailContext';
import { __resetTabIdForTest } from '../src/api/draft';
import { useDraftSession } from '../src/hooks/useDraftSession';
import type { DiffDto, PrDetailDto, PrReference, ReviewSessionDto } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

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

const minimalPrDetail: PrDetailDto = {
  pr: {
    reference: ref,
    title: 'Test PR',
    body: '',
    author: 'test',
    state: 'open',
    headSha: 'headabc',
    baseSha: 'basedef',
    headBranch: 'feature',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  },
  clusteringQuality: 'ok',
  iterations: [
    {
      number: 1,
      beforeSha: 'basedef',
      afterSha: 'headabc',
      commits: [],
      hasResolvableRange: true,
    },
  ],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

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

function sessionWithDraftAt(
  filePath: string,
  lineNumber: number,
  side: 'left' | 'right',
  body: string,
): ReviewSessionDto {
  return {
    ...emptySession(),
    draftComments: [
      {
        id: 'uuid-existing',
        filePath,
        lineNumber,
        side,
        anchoredSha: 'a'.repeat(40),
        anchoredLineContent: '  return 1;',
        bodyMarkdown: body,
        status: 'draft',
        isOverriddenStale: false,
        postedCommentId: null,
      },
    ],
  };
}

function makeRouteHandler(
  diff: DiffDto,
  session: ReviewSessionDto,
  patchTracker?: { calls: { url: string; body: unknown }[] },
) {
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
        patchTracker?.calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
        return Promise.resolve(
          new Response(JSON.stringify({ postedCommentId: 12345 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/draft') && method === 'PUT') {
        const body = init?.body ? (JSON.parse(init.body as string) as unknown) : null;
        patchTracker?.calls.push({ url, body });
        // newDraftComment / newPrRootDraftComment / newDraftReply require an
        // assignedId. Other patches return empty 200.
        const isCreate =
          body !== null &&
          typeof body === 'object' &&
          ('newDraftComment' in body || 'newPrRootDraftComment' in body || 'newDraftReply' in body);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              isCreate ? { assignedId: `uuid-new-${patchTracker?.calls.length ?? 0}` } : {},
            ),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function Wrapper({ prDetail }: { prDetail: PrDetailDto }) {
  // Mirrors the host's ownership of the draft session. FilesTab reads
  // prRef/prDetail/session/readOnly from the PrDetail context (Task 2); the
  // legacy Outlet `context` prop is gone (Task 5 removed the nested-route
  // Outlet), leaving FilesTab as the bare Outlet leaf.
  const draftSession = useDraftSession(ref);
  return (
    <PrDetailContextProvider
      value={{ prRef: ref, prDetail, draftSession, readOnly: false, onSelectSubTab: () => {} }}
    >
      <Outlet />
    </PrDetailContextProvider>
  );
}

function renderFilesTab() {
  return render(
    <MemoryRouter initialEntries={['/pr/octocat/hello/42/files']}>
      <Routes>
        <Route path="/pr/:owner/:repo/:number" element={<Wrapper prDetail={minimalPrDetail} />}>
          <Route path="files/*" element={<FilesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
  __resetTabIdForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilesTab — diff-line-click composer mount', () => {
  it('clicking the comment-affordance for a line opens an InlineCommentComposer', async () => {
    globalThis.fetch = makeRouteHandler(onefileDiff, emptySession()) as unknown as typeof fetch;
    renderFilesTab();

    // Wait for the diff to render (file appears in tree).
    // Atomic find-and-click: do the click inside waitFor's retry cycle so a
    // race between waitFor's success callback and the next sync line cannot
    // flip the file tree back to skeleton between query and click.
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    // The "Add comment" affordance button is on each non-deleted line.
    // Click line 1 (the first line of the new content).
    const lineButton = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(lineButton);

    // The InlineCommentComposer is now mounted. role="form" with aria-label.
    await waitFor(() =>
      expect(
        screen.getByRole('form', { name: 'Draft comment on src/main.ts line 1' }),
      ).toBeInTheDocument(),
    );
  });

  it('clicking a line that already has a saved draft hydrates the composer with the existing body', async () => {
    const session = sessionWithDraftAt('src/main.ts', 1, 'right', 'pre-existing body');
    globalThis.fetch = makeRouteHandler(onefileDiff, session) as unknown as typeof fetch;
    renderFilesTab();

    // Atomic find-and-click: do the click inside waitFor's retry cycle so a
    // race between waitFor's success callback and the next sync line cannot
    // flip the file tree back to skeleton between query and click.
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    const lineButton = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(lineButton);

    const textarea = (await screen.findByLabelText('Comment body')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('pre-existing body');
  });
});

describe('FilesTab — A2 click-another-line flow (addendum A2)', () => {
  it('ClickAnotherLine_NoExistingDraft_OpensNewComposerImmediately', async () => {
    globalThis.fetch = makeRouteHandler(onefileDiff, emptySession()) as unknown as typeof fetch;
    renderFilesTab();

    // Atomic find-and-click: do the click inside waitFor's retry cycle so a
    // race between waitFor's success callback and the next sync line cannot
    // flip the file tree back to skeleton between query and click.
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);
    await waitFor(() =>
      expect(
        screen.getByRole('form', { name: 'Draft comment on src/main.ts line 1' }),
      ).toBeInTheDocument(),
    );

    // No persisted draftId on the active composer → click line 2 → no modal,
    // composer moves immediately.
    const line2 = screen.getByRole('button', { name: 'Add comment on line 3' });
    fireEvent.click(line2);

    expect(screen.queryByText(/Discard or keep your saved draft/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('form', { name: 'Draft comment on src/main.ts line 3' }),
      ).toBeInTheDocument(),
    );
  });

  it('ClickAnotherLine_ExistingDraftSaved_OpensNewComposerImmediately_NoModal', async () => {
    // #299 fix #2: drafts auto-save as you type, so a line switch never needs a
    // "keep or discard?" prompt — the existing draft is already saved. Switching
    // lines just keeps it and opens the new composer. Discard stays an explicit
    // action on the composer itself.
    const tracker = { calls: [] as { url: string; body: unknown }[] };
    const session = sessionWithDraftAt('src/main.ts', 1, 'right', 'saved body');
    globalThis.fetch = makeRouteHandler(onefileDiff, session, tracker) as unknown as typeof fetch;
    renderFilesTab();

    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    // Open composer at line 1 → composerDraftId === 'uuid-existing'.
    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);
    await screen.findByRole('form', { name: 'Draft comment on src/main.ts line 1' });

    // Click line 3 → composer moves immediately, NO modal.
    const line3 = screen.getByRole('button', { name: 'Add comment on line 3' });
    fireEvent.click(line3);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Discard or keep your saved draft/i)).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole('form', { name: 'Draft comment on src/main.ts line 3' }),
      ).toBeInTheDocument(),
    );

    // Keep semantics: the saved draft was NOT deleted by the switch.
    const deleteCalls = tracker.calls.filter((c) => {
      const b = c.body as Record<string, unknown> | null;
      return !!b && 'deleteDraftComment' in b;
    });
    expect(deleteCalls).toHaveLength(0);
  });

  it('RapidLineSwitch_FlushesPendingDraft_NoLostWork', async () => {
    // #299 acceptance: no lost-draft on rapid line-to-line authoring. With the
    // transition modal gone, a line switch unmounts the composer immediately;
    // without a flush, an edit typed within the 250ms debounce window would be
    // dropped. Typing then switching lines before the debounce fires must still
    // persist the in-progress draft.
    const tracker = { calls: [] as { url: string; body: unknown }[] };
    globalThis.fetch = makeRouteHandler(
      onefileDiff,
      emptySession(),
      tracker,
    ) as unknown as typeof fetch;
    renderFilesTab();

    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);
    const textarea = (await screen.findByLabelText('Comment body')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'flush me before switching' } });

    // Switch lines immediately — do NOT wait for the debounce.
    fireEvent.click(screen.getByRole('button', { name: 'Add comment on line 3' }));

    await waitFor(() => {
      const creates = tracker.calls.filter((c) => {
        const b = c.body as Record<string, unknown> | null;
        return !!b && 'newDraftComment' in b;
      });
      expect(creates).toHaveLength(1);
    });
    const create = tracker.calls.find((c) => {
      const b = c.body as Record<string, unknown> | null;
      return !!b && 'newDraftComment' in b;
    });
    const payload = (
      create!.body as { newDraftComment: { bodyMarkdown: string; lineNumber: number } }
    ).newDraftComment;
    expect(payload.bodyMarkdown).toBe('flush me before switching');
    expect(payload.lineNumber).toBe(1);
  });
});

describe('FilesTab — inline post-now wiring (#302 Task 11a)', () => {
  it('clicking Comment on a saved inline draft posts via /comment/post and then refetches the session', async () => {
    // A saved draft already exists on line 1, so the composer mounts with a
    // persisted draftId and the post-now "Comment" button is enabled.
    const tracker = { calls: [] as { url: string; body: unknown }[] };
    const handler = makeRouteHandler(
      onefileDiff,
      sessionWithDraftAt('src/main.ts', 1, 'right', 'a saved body'),
      tracker,
    );
    globalThis.fetch = handler as unknown as typeof fetch;
    renderFilesTab();

    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    const lineButton = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(lineButton);

    // Composer hydrates from the saved draft.
    await screen.findByRole('form', { name: 'Draft comment on src/main.ts line 1' });

    // Count GET /draft fetches up to this point so we can assert a *new* one
    // (the refetch) fires after the post lands.
    const getDraftCallsBefore = handler.mock.calls.filter(
      (call: unknown[]) => {
        const u = call[0];
        const init = call[1] as RequestInit | undefined;
        return typeof u === 'string' && u.endsWith('/draft') && (init?.method ?? 'GET') === 'GET';
      },
    ).length;

    // Click "Comment" (post-now). With a valid persisted draft and no other
    // staged drafts, the button is enabled.
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    // The post hits POST /comment/post with the draft id...
    await waitFor(() => {
      const posts = tracker.calls.filter((c) => c.url.endsWith('/comment/post'));
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({ draftId: 'uuid-existing' });
    });

    // ...and the session is refetched (a new GET /draft) so the posted comment
    // surfaces via the existing refetch-on-save (11a — no optimistic insert).
    await waitFor(() => {
      const getDraftCallsAfter = handler.mock.calls.filter((call: unknown[]) => {
        const u = call[0];
        const init = call[1] as RequestInit | undefined;
        return typeof u === 'string' && u.endsWith('/draft') && (init?.method ?? 'GET') === 'GET';
      }).length;
      expect(getDraftCallsAfter).toBeGreaterThan(getDraftCallsBefore);
    });

    // The composer closed after a successful post.
    await waitFor(() =>
      expect(
        screen.queryByRole('form', { name: 'Draft comment on src/main.ts line 1' }),
      ).not.toBeInTheDocument(),
    );
  });
});
