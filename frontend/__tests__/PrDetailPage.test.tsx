import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { PrDetailPage } from '../src/pages/PrDetailPage';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import type { PrDetailDto } from '../src/api/types';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get instance(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() {
    this.closed = true;
  }
  dispatch(type: string, data: unknown) {
    this.listeners[type]?.forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const sampleDto: PrDetailDto = {
  pr: {
    reference: { owner: 'octocat', repo: 'hello', number: 42 },
    title: 'Refactor the renewal worker',
    body: '',
    author: 'amelia.cho',
    state: 'open',
    headSha: 'abc123',
    baseSha: 'def456',
    headBranch: 'amelia/work',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00Z',
  },
  clusteringQuality: 'ok',
  iterations: [
    { number: 1, beforeSha: 'a', afterSha: 'b', commits: [], hasResolvableRange: true },
    { number: 2, beforeSha: 'b', afterSha: 'abc123', commits: [], hasResolvableRange: true },
  ],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

function jsonResponse(data: unknown, status = 200): Response {
  const isNoBody = status === 204;
  return new Response(isNoBody ? null : JSON.stringify(data), {
    status,
    headers: isNoBody ? undefined : { 'Content-Type': 'application/json' },
  });
}

function mountAt(path: string, fetchImpl?: typeof fetch): ReactNode {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  return (
    <MemoryRouter initialEntries={[path]}>
      <EventStreamProvider>
        <Routes>
          <Route path="/pr/:owner/:repo/:number" element={<PrDetailPage />}>
            <Route index element={<div data-testid="overview-content">OVERVIEW</div>} />
            <Route path="files/*" element={<div data-testid="files-content">FILES</div>} />
            <Route path="drafts" element={<div data-testid="drafts-content">DRAFTS</div>} />
          </Route>
        </Routes>
      </EventStreamProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PrDetailPage', () => {
  it('renders PrHeader with title + author after detail fetch resolves', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    expect(await screen.findByText('Refactor the renewal worker')).toBeInTheDocument();
    expect(screen.getByText(/amelia\.cho/i)).toBeInTheDocument();
  });

  it('renders the index (Overview) route by default at /pr/:owner/:repo/:number', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    expect(await screen.findByTestId('overview-content')).toBeInTheDocument();
  });

  it('renders the Files route when path ends in /files', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42/files', fetchMock as typeof fetch));
    expect(await screen.findByTestId('files-content')).toBeInTheDocument();
  });

  it('navigates to Files when the Files tab is clicked', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    await screen.findByTestId('overview-content');
    await userEvent.click(screen.getByRole('tab', { name: /files/i }));
    expect(await screen.findByTestId('files-content')).toBeInTheDocument();
  });

  it('shows the BannerRefresh when a pr-updated SSE event arrives for this PR', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    await screen.findByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: true,
        commentCountDelta: 0,
      }),
    );
    expect(await screen.findByText(/Iteration 3 available/i)).toBeInTheDocument();
  });

  it('keeps tab selection in sync with the raw route segment (no parse-rewrite)', async () => {
    // Regression: basePath was built from the parsed numeric value (e.g. 42),
    // so for /pr/o/r/042/files the pathname ('/pr/o/r/042/files') no longer
    // started with basePath ('/pr/o/r/42'), and tabFromPath fell back to
    // 'overview' even though the rendered Outlet was Files. The Files tab
    // would not show as selected. basePath must keep the raw route segment.
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/042/files', fetchMock as typeof fetch));
    await screen.findByTestId('files-content');
    expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('does not match the Files tab on lookalike paths like /files-extra', async () => {
    // Regression: tabFromPath() previously used startsWith('/files'), which
    // treated /files-extra (and any /files<X>) as a Files-tab match even
    // though the nested router wouldn't render Files for that path. The tab
    // strip would highlight Files while the Outlet rendered Overview (or 404).
    // Match must require either exact '/files' or a '/files/' path prefix.
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    globalThis.fetch = fetchMock as typeof fetch;
    render(
      <MemoryRouter initialEntries={['/pr/octocat/hello/42/files-extra']}>
        <EventStreamProvider>
          <Routes>
            <Route path="/pr/:owner/:repo/:number" element={<PrDetailPage />}>
              <Route index element={<div data-testid="overview-content">OVERVIEW</div>} />
              <Route path="files/*" element={<div data-testid="files-content">FILES</div>} />
              <Route path="drafts" element={<div data-testid="drafts-content">DRAFTS</div>} />
              <Route path="*" element={<div data-testid="nomatch">NOMATCH</div>} />
            </Route>
          </Routes>
        </EventStreamProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Refactor the renewal worker');
    expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('Reload click triggers a re-fetch and clears the banner', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(sampleDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    await screen.findByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const initialDetailFetches = fetchMock.mock.calls.filter(
      (c: unknown[]) => c[0] === '/api/pr/octocat/hello/42',
    ).length;

    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 2,
      }),
    );
    const banner = await screen.findByText(/2 new comments — Reload to view/i);
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(
        (c: unknown[]) => c[0] === '/api/pr/octocat/hello/42',
      ).length;
      expect(after).toBeGreaterThan(initialDetailFetches);
    });
    await waitFor(() => expect(banner).not.toBeInTheDocument());
  });
});
