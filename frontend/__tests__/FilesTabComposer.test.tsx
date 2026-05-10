import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from '../src/components/PrDetail/FilesTab/FilesTab';
import { __resetTabIdForTest } from '../src/api/draft';
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
    draftSummaryMarkdown: null,
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
  return <Outlet context={{ prDetail }} />;
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

  it('ClickAnotherLine_ExistingDraftSaved_ShowsModalWithDiscardOrKeep', async () => {
    // Session already has a draft on line 1.
    const session = sessionWithDraftAt('src/main.ts', 1, 'right', 'saved body');
    globalThis.fetch = makeRouteHandler(onefileDiff, session) as unknown as typeof fetch;
    renderFilesTab();

    // Atomic find-and-click: do the click inside waitFor's retry cycle so a
    // race between waitFor's success callback and the next sync line cannot
    // flip the file tree back to skeleton between query and click.
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    // Open composer at line 1 → composerDraftId === 'uuid-existing'.
    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);

    // Click line 3 → A2 modal appears.
    const line3 = screen.getByRole('button', { name: 'Add comment on line 3' });
    fireEvent.click(line3);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Discard or keep your saved draft/i);
    expect(within(dialog).getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('ClickAnotherLine_DiscardBranch_FiresDeleteDraftComment', async () => {
    const tracker = { calls: [] as { url: string; body: unknown }[] };
    const session = sessionWithDraftAt('src/main.ts', 1, 'right', 'saved body');
    globalThis.fetch = makeRouteHandler(onefileDiff, session, tracker) as unknown as typeof fetch;
    renderFilesTab();

    // Atomic find-and-click: do the click inside waitFor's retry cycle so a
    // race between waitFor's success callback and the next sync line cannot
    // flip the file tree back to skeleton between query and click.
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);
    const line3 = screen.getByRole('button', { name: 'Add comment on line 3' });
    fireEvent.click(line3);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => {
      const deleteCalls = tracker.calls.filter((c) => {
        const b = c.body as Record<string, unknown> | null;
        return !!b && 'deleteDraftComment' in b;
      });
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });
    const deleteCall = tracker.calls.find(
      (c) =>
        typeof c.body === 'object' &&
        c.body !== null &&
        'deleteDraftComment' in (c.body as Record<string, unknown>),
    );
    expect(deleteCall?.body).toEqual({ deleteDraftComment: { id: 'uuid-existing' } });
  });

  it('ClickAnotherLine_KeepBranch_LeavesDraftPersisted', async () => {
    const tracker = { calls: [] as { url: string; body: unknown }[] };
    const session = sessionWithDraftAt('src/main.ts', 1, 'right', 'saved body');
    globalThis.fetch = makeRouteHandler(onefileDiff, session, tracker) as unknown as typeof fetch;
    renderFilesTab();

    // Atomic find-and-click: do the click inside waitFor's retry cycle so a
    // race between waitFor's success callback and the next sync line cannot
    // flip the file tree back to skeleton between query and click.
    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);
    const line3 = screen.getByRole('button', { name: 'Add comment on line 3' });
    fireEvent.click(line3);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));

    // The Keep branch must NOT issue a deleteDraftComment.
    const deleteCalls = tracker.calls.filter((c) => {
      const b = c.body as Record<string, unknown> | null;
      return !!b && 'deleteDraftComment' in b;
    });
    expect(deleteCalls).toHaveLength(0);

    // Composer is now at line 3; the modal is closed.
    await waitFor(() =>
      expect(
        screen.getByRole('form', { name: 'Draft comment on src/main.ts line 3' }),
      ).toBeInTheDocument(),
    );
  });
});
