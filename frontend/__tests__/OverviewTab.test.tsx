import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet, useLocation } from 'react-router-dom';
import { OverviewTab } from '../src/components/PrDetail/OverviewTab/OverviewTab';
import type { PrDetailDto, DiffDto, PrReference } from '../src/api/types';

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
  const fetchMock = mockFetch(opts);
  globalThis.fetch = fetchMock as typeof fetch;
  const prDetailForRoute = opts.detail ?? baseDetail;
  return render(
    <MemoryRouter initialEntries={['/pr/octocat/hello/42']}>
      <Routes>
        <Route
          path="/pr/:owner/:repo/:number"
          element={<Outlet context={{ prDetail: prDetailForRoute }} />}
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

  it('renders PrRootConversation with the rootComments and the S4 footer', async () => {
    mountOverview();
    await screen.findByText('reviewer1');
    expect(screen.getByText('reviewer2')).toBeInTheDocument();
    expect(
      screen.getByText(/Reply lands when the comment composer ships in S4\./),
    ).toBeInTheDocument();
  });

  it('navigates to the Files route when "Review files" is clicked', async () => {
    mountOverview();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /review files/i })).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /review files/i }));
    expect(await screen.findByTestId('files-content')).toBeInTheDocument();
  });

  it('disables the "Review files" CTA with the empty-state tooltip on an empty PR', async () => {
    mountOverview({ diff: emptyDiff });
    const button = await screen.findByRole('button', { name: /review files/i });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute('title', 'No files to review yet');
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
