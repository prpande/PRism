import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { FilesTab } from '../src/components/PrDetail/FilesTab/FilesTab';
import { DraftsTab } from '../src/components/PrDetail/DraftsTab/DraftsTab';
import { PrDetailContextProvider } from '../src/components/PrDetail/prDetailContext';
import { __resetTabIdForTest } from '../src/api/draft';
import { useDraftSession } from '../src/hooks/useDraftSession';
import type {
  DiffDto,
  DraftCommentDto,
  PrDetailDto,
  PrReference,
  ReviewSessionDto,
} from '../src/api/types';

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

// Stateful mock backend: GET /draft reflects whatever PUT /draft has mutated,
// faithfully mirroring the local PRism backend (store.LoadAsync over a session
// that PUT patches mutate). This is what makes the "live" assertion real — the
// Drafts tab can only reflect a just-saved draft if a refetch re-reads the
// updated server state.
function makeStatefulBackend(diff: DiffDto) {
  const session = emptySession();
  let seq = 0;

  const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const json = (payload: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    if (typeof url === 'string') {
      if (url.includes('/diff')) return json(diff);

      if (url.endsWith('/draft') && method === 'GET') {
        // Deep-ish clone so consumers can't mutate the backend's copy.
        return json({ ...session, draftComments: session.draftComments.map((c) => ({ ...c })) });
      }

      if (url.endsWith('/draft') && method === 'PUT') {
        const body = init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : null;
        if (body && 'newDraftComment' in body) {
          const p = body.newDraftComment as {
            filePath: string;
            lineNumber: number;
            side: 'left' | 'right';
            anchoredSha: string;
            anchoredLineContent: string;
            bodyMarkdown: string;
          };
          const id = `uuid-new-${++seq}`;
          const created: DraftCommentDto = {
            id,
            filePath: p.filePath,
            lineNumber: p.lineNumber,
            side: p.side,
            anchoredSha: p.anchoredSha,
            anchoredLineContent: p.anchoredLineContent,
            bodyMarkdown: p.bodyMarkdown,
            status: 'draft',
            isOverriddenStale: false,
            postedCommentId: null,
          };
          session.draftComments.push(created);
          return json({ assignedId: id });
        }
        if (body && 'updateDraftComment' in body) {
          const p = body.updateDraftComment as { id: string; bodyMarkdown: string };
          const match = session.draftComments.find((c) => c.id === p.id);
          if (match) match.bodyMarkdown = p.bodyMarkdown;
          return json({});
        }
        if (body && 'deleteDraftComment' in body) {
          const p = body.deleteDraftComment as { id: string };
          const idx = session.draftComments.findIndex((c) => c.id === p.id);
          if (idx >= 0) session.draftComments.splice(idx, 1);
          return json({});
        }
        return json({});
      }
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });

  return { fetchImpl, session };
}

// Renders the Files tab and the Drafts tab under ONE shared draft session —
// the production keep-alive arrangement (both tabs live under the same
// PrDetail provider, both reading the single source of truth).
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
        onSelectSubTab: () => {},
      }}
    >
      <FilesTab />
      <DraftsTab
        prRef={ref}
        session={draftSession.session}
        status={draftSession.status}
        refetch={draftSession.refetch}
      />
    </PrDetailContextProvider>
  );
}

function renderBothTabs() {
  return render(
    <MemoryRouter initialEntries={['/pr/octocat/hello/42/files']}>
      <Wrapper prDetail={minimalPrDetail} />
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

describe('#299 — inline draft appears in Drafts tab live (no composer close)', () => {
  it('a comment auto-saved in the diff shows up in the Drafts tab without closing the composer', async () => {
    const { fetchImpl } = makeStatefulBackend(onefileDiff);
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    renderBothTabs();

    await waitFor(() => {
      fireEvent.click(screen.getByText('main.ts'));
    });

    // Drafts tab starts empty.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('drafts-tab-root')).getByText(/no drafts/i),
      ).toBeInTheDocument(),
    );

    // Open the composer on line 1 and type past the create threshold.
    const line1 = await screen.findByRole('button', { name: 'Add comment on line 1' });
    fireEvent.click(line1);
    const textarea = (await screen.findByLabelText('Comment body')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'needs a tweak here' } });

    // The composer is STILL open (we never closed it) ...
    expect(
      screen.getByRole('form', { name: 'Draft comment on src/main.ts line 1' }),
    ).toBeInTheDocument();

    // ... and the Drafts tab reflects the saved draft live.
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId('drafts-tab-root')).getByText(/1 draft/i),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});
