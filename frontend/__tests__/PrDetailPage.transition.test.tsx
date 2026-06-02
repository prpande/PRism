import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { PrDetailPage } from '../src/pages/PrDetailPage';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { OpenTabsProvider } from '../src/contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../src/contexts/AskAiDrawerContext';
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

// Open PR — the detail data says isMerged=false, isClosed=false.
// The SSE event will carry isMerged/isClosed to simulate the live transition.
const openPrDto: PrDetailDto = {
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
    mergedAt: null,
    closedAt: null,
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
        <OpenTabsProvider>
          <AskAiDrawerProvider>
            <Routes>
              <Route path="/pr/:owner/:repo/:number" element={<PrDetailPage />}>
                <Route index element={<div data-testid="overview-content">OVERVIEW</div>} />
                <Route path="files/*" element={<div data-testid="files-content">FILES</div>} />
                <Route path="drafts" element={<div data-testid="drafts-content">DRAFTS</div>} />
              </Route>
            </Routes>
          </AskAiDrawerProvider>
        </OpenTabsProvider>
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

describe('PrDetailPage — live merge/close transition banner', () => {
  it('shows the transition banner and hides BannerRefresh when the PR becomes merged', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(openPrDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    // Wait for PR detail to load
    await screen.findByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // Fire a pr-updated event with isMerged=true (live transition while viewing)
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: true,
        commentCountDelta: 0,
        isMerged: true,
        isClosed: false,
      }),
    );

    // Transition banner must appear with the correct copy
    expect(await screen.findByText(/just merged/i)).toBeInTheDocument();
    expect(screen.getByText(/Reload to read-only view/i)).toBeInTheDocument();

    // BannerRefresh must NOT be present (superseded)
    expect(screen.queryByTestId('reload-banner')).not.toBeInTheDocument();
  });

  it('shows "just closed" copy when the PR becomes closed (not merged)', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(openPrDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    await screen.findByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: true,
      }),
    );

    expect(await screen.findByText(/just closed/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reload-banner')).not.toBeInTheDocument();
  });

  it('transition banner is not dismissible (no "Dismiss banner" control)', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(openPrDto));
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
        isMerged: true,
        isClosed: false,
      }),
    );

    await screen.findByText(/just merged/i);

    // BannerRefresh has aria-label="Dismiss banner"; transition banner must not
    expect(screen.queryByLabelText(/dismiss banner/i)).not.toBeInTheDocument();
  });

  it('does NOT show the transition banner when the loaded detail is already done (no live transition)', async () => {
    // Simulate a PR that was already merged before the page loaded. The detail
    // data says isMerged=true. Even if an SSE event fires isMerged=true, there
    // is no "transitioned while viewing" gap — detailIsDone is true.
    const alreadyMergedDto: PrDetailDto = {
      ...openPrDto,
      pr: {
        ...openPrDto.pr,
        state: 'merged',
        isMerged: true,
        isClosed: false,
        mergedAt: '2026-05-10T12:00:00Z',
      },
    };
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42')
        return Promise.resolve(jsonResponse(alreadyMergedDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    render(mountAt('/pr/octocat/hello/42', fetchMock as typeof fetch));
    await screen.findByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
        isMerged: true,
        isClosed: false,
      }),
    );

    // Neither transition banner nor BannerRefresh (no headSha/comment delta)
    expect(screen.queryByText(/just merged/i)).not.toBeInTheDocument();
  });
});
