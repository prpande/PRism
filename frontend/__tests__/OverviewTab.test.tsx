import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet, useLocation } from 'react-router-dom';
import { OverviewTab } from '../src/components/PrDetail/OverviewTab/OverviewTab';
import type { PrDetailDto, DiffDto, PrReference, ReviewSessionDto } from '../src/api/types';
import type { UseDraftSessionResult } from '../src/hooks/useDraftSession';

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

function fakeDraftSession(overrides: Partial<UseDraftSessionResult> = {}): UseDraftSessionResult {
  return {
    session: emptySession(),
    status: 'ready',
    error: null,
    refetch: () => Promise.resolve(),
    registerOpenComposer: () => () => undefined,
    outOfBandToast: null,
    clearOutOfBandToast: () => undefined,
    ...overrides,
  };
}

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const baseDetail: PrDetailDto = {
  pr: {
    reference: ref,
    title: 'Refactor the renewal worker',
    body: 'Replaces the per-lease loop with **Task.WhenAll**.',
    author: 'amelia.cho',
    state: 'open',
    headSha: 'headabc',
    baseSha: 'basedef',
    headBranch: 'amelia/work',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00Z',
  },
  clusteringQuality: 'ok',
  iterations: null,
  commits: [],
  rootComments: [
    { id: 1, author: 'reviewer1', createdAt: '2026-05-08T14:00:00Z', body: 'Looks good.' },
    { id: 2, author: 'reviewer2', createdAt: '2026-05-08T15:00:00Z', body: 'Also LGTM.' },
  ],
  reviewComments: [
    {
      threadId: 't1',
      filePath: 'a.cs',
      lineNumber: 1,
      anchorSha: 'h',
      isResolved: false,
      comments: [],
    },
    {
      threadId: 't2',
      filePath: 'b.cs',
      lineNumber: 2,
      anchorSha: 'h',
      isResolved: false,
      comments: [],
    },
    {
      threadId: 't3',
      filePath: 'c.cs',
      lineNumber: 3,
      anchorSha: 'h',
      isResolved: true,
      comments: [],
    },
  ],
  timelineCapHit: false,
};

const sampleDiff: DiffDto = {
  range: 'basedef..headabc',
  files: [
    { path: 'src/main.ts', status: 'modified', hunks: [] },
    { path: 'README.md', status: 'added', hunks: [] },
  ],
  truncated: false,
};

const emptyDiff: DiffDto = { range: 'basedef..headabc', files: [], truncated: false };

interface MockOptions {
  detail?: PrDetailDto;
  diff?: DiffDto;
  aiPreview?: boolean;
  capabilitiesOn?: boolean;
  aiSummary?: { body: string; category: string } | null;
  draftSession?: UseDraftSessionResult;
}

function jsonResponse(data: unknown, status = 200): Response {
  const isNoBody = status === 204;
  return new Response(isNoBody ? null : JSON.stringify(data), {
    status,
    headers: isNoBody ? undefined : { 'Content-Type': 'application/json' },
  });
}

function mockFetch(opts: MockOptions = {}) {
  const diff = opts.diff ?? sampleDiff;
  const aiPreview = opts.aiPreview ?? false;
  const capsOn = opts.capabilitiesOn ?? aiPreview;
  const summary = opts.aiSummary;

  return vi.fn().mockImplementation((path: string) => {
    if (path.startsWith('/api/preferences')) {
      return Promise.resolve(jsonResponse({ theme: 'system', accent: 'indigo', aiPreview }));
    }
    if (path.startsWith('/api/capabilities')) {
      return Promise.resolve(
        jsonResponse({
          ai: {
            summary: capsOn,
            fileFocus: capsOn,
            hunkAnnotations: capsOn,
            preSubmitValidators: capsOn,
            composerAssist: capsOn,
            draftSuggestions: capsOn,
            draftReconciliation: capsOn,
            inboxEnrichment: capsOn,
            inboxRanking: capsOn,
          },
        }),
      );
    }
    if (path.includes('/diff')) {
      return Promise.resolve(jsonResponse(diff));
    }
    if (path.includes('/ai/summary')) {
      return summary
        ? Promise.resolve(jsonResponse(summary))
        : Promise.resolve(jsonResponse(null, 204));
    }
    return Promise.resolve(jsonResponse({}, 204));
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function mountOverview(opts: MockOptions = {}) {
  // Use vi.spyOn so vi.restoreAllMocks() in afterEach actually unwinds the
  // override. Direct assignment to globalThis.fetch is not restored by
  // restoreAllMocks and leaks across tests when a worker is reused.
  const fetchMock = mockFetch(opts);
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
  const prDetailForRoute = opts.detail ?? baseDetail;
  const draftSession = opts.draftSession ?? fakeDraftSession();
  return render(
    <MemoryRouter initialEntries={['/pr/octocat/hello/42']}>
      <Routes>
        <Route
          path="/pr/:owner/:repo/:number"
          element={<Outlet context={{ prDetail: prDetailForRoute, draftSession }} />}
        >
          <Route index element={<OverviewTab />} />
          <Route path="files/*" element={<div data-testid="files-content">FILES</div>} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OverviewTab', () => {
  it('renders PR description body as Markdown', async () => {
    mountOverview();
    const strong = await screen.findByText('Task.WhenAll');
    expect(strong.tagName.toLowerCase()).toBe('strong');
  });

  it('applies overview-card-hero-no-ai when aiPreview is off (PoC default)', async () => {
    const { container } = mountOverview({ aiPreview: false });
    await screen.findByText('Task.WhenAll');
    expect(container.querySelector('.pr-description')).toHaveClass('overview-card-hero-no-ai');
  });

  it('renders stats with files from diff fetch and threads from reviewComments', async () => {
    mountOverview();
    await waitFor(() =>
      expect(screen.getByText('Files').nextElementSibling?.textContent).toBe('2'),
    );
    expect(screen.getByText('Threads').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('Drafts').nextElementSibling?.textContent).toBe('0');
    expect(screen.getByText('Viewed').nextElementSibling?.textContent).toBe('0/2');
  });

  it('renders PrRootConversation with the rootComments plus the PR5 actions (Reply + Mark all read)', async () => {
    mountOverview();
    await screen.findByText('reviewer1');
    expect(screen.getByText('reviewer2')).toBeInTheDocument();
    // S3 footer placeholder is gone — S4 PR5 wires real actions.
    expect(screen.queryByText(/Composer not available in this context\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeInTheDocument();
  });

  it('navigates to the Files route when "Review files" is clicked', async () => {
    mountOverview();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /review files/i })).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /review files/i }));
    expect(await screen.findByTestId('files-content')).toBeInTheDocument();
  });

  it('disables the "Review files" CTA with the empty-state help text on an empty PR', async () => {
    mountOverview({ diff: emptyDiff });
    const button = await screen.findByRole('button', { name: /review files/i });
    await waitFor(() => expect(button).toBeDisabled());
    // aria-describedby points at a visible, AT-readable help paragraph.
    expect(button).toHaveAttribute('aria-describedby');
    expect(screen.getByText('No files to review yet')).toBeInTheDocument();
  });

  it('keeps the "Review files" CTA enabled while the diff is still loading', async () => {
    // Hold the diff response open so OverviewTab spends the entire test in
    // the loading window. CTA must NOT show the empty-state help; the user
    // navigates to the Files tab where skeleton/error UX lives.
    let releaseDiff: () => void = () => undefined;
    const diffPromise = new Promise<Response>((resolve) => {
      releaseDiff = () => resolve(jsonResponse(sampleDiff));
    });
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path.startsWith('/api/preferences')) {
        return Promise.resolve(
          jsonResponse({ theme: 'system', accent: 'indigo', aiPreview: false }),
        );
      }
      if (path.startsWith('/api/capabilities')) {
        return Promise.resolve(
          jsonResponse({
            ai: {
              summary: false,
              fileFocus: false,
              hunkAnnotations: false,
              preSubmitValidators: false,
              composerAssist: false,
              draftSuggestions: false,
              draftReconciliation: false,
              inboxEnrichment: false,
              inboxRanking: false,
            },
          }),
        );
      }
      if (path.includes('/diff')) return diffPromise;
      return Promise.resolve(jsonResponse({}, 204));
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    render(
      <MemoryRouter initialEntries={['/pr/octocat/hello/42']}>
        <Routes>
          <Route
            path="/pr/:owner/:repo/:number"
            element={
              <Outlet context={{ prDetail: baseDetail, draftSession: fakeDraftSession() }} />
            }
          >
            <Route index element={<OverviewTab />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    // Description renders without waiting on the diff, so we can sample the
    // CTA mid-load.
    await screen.findByText('Task.WhenAll');
    const button = screen.getByRole('button', { name: /review files/i });
    expect(button).not.toBeDisabled();
    expect(screen.queryByText('No files to review yet')).not.toBeInTheDocument();
    releaseDiff();
  });

  it('keeps the "Review files" CTA enabled when the diff fetch errors', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path.startsWith('/api/preferences')) {
        return Promise.resolve(
          jsonResponse({ theme: 'system', accent: 'indigo', aiPreview: false }),
        );
      }
      if (path.startsWith('/api/capabilities')) {
        return Promise.resolve(
          jsonResponse({
            ai: {
              summary: false,
              fileFocus: false,
              hunkAnnotations: false,
              preSubmitValidators: false,
              composerAssist: false,
              draftSuggestions: false,
              draftReconciliation: false,
              inboxEnrichment: false,
              inboxRanking: false,
            },
          }),
        );
      }
      if (path.includes('/diff')) return Promise.reject(new Error('network down'));
      return Promise.resolve(jsonResponse({}, 204));
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    render(
      <MemoryRouter initialEntries={['/pr/octocat/hello/42']}>
        <Routes>
          <Route
            path="/pr/:owner/:repo/:number"
            element={
              <Outlet context={{ prDetail: baseDetail, draftSession: fakeDraftSession() }} />
            }
          >
            <Route index element={<OverviewTab />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Task.WhenAll');
    // Wait one tick so the rejected diff promise has been observed by the hook.
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /review files/i });
      // CTA stays enabled — error UX lives on the Files tab.
      expect(button).not.toBeDisabled();
    });
    expect(screen.queryByText('No files to review yet')).not.toBeInTheDocument();
  });

  it('does NOT render AiSummaryCard when aiPreview is off (PoC default)', async () => {
    const { container } = mountOverview({ aiPreview: false });
    await screen.findByText('Task.WhenAll');
    expect(container.querySelector('.ai-summary-card')).toBeNull();
  });

  it('renders AiSummaryCard with PlaceholderPrSummarizer content when aiPreview is on', async () => {
    mountOverview({
      aiPreview: true,
      capabilitiesOn: true,
      aiSummary: { body: 'Placeholder summary body.', category: 'Refactor' },
    });
    await screen.findByText('Placeholder summary body.');
    expect(screen.getByText('Refactor')).toBeInTheDocument();
    expect(
      screen.getByText(/AI preview — sample content, not generated from this PR/),
    ).toBeInTheDocument();
  });

  it('AiSummaryCard takes the hero when aiPreview is on (PrDescription drops the no-ai modifier)', async () => {
    const { container } = mountOverview({
      aiPreview: true,
      capabilitiesOn: true,
      aiSummary: { body: 'Hero', category: 'cat' },
    });
    await screen.findByText('Hero');
    expect(container.querySelector('.pr-description')).not.toHaveClass('overview-card-hero-no-ai');
    expect(container.querySelector('.ai-summary-card')).toHaveClass('overview-card-hero');
  });
});
