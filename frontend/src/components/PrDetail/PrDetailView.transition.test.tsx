import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PrDetailView } from './PrDetailView';
import { EventStreamProvider } from '../../hooks/useEventSource';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import type { PrDetailDto } from '../../api/types';
import {
  FakeEventSource,
  installFakeEventSource,
} from '../../../__tests__/helpers/fakeEventSource';
import { jsonResponse } from '../../../__tests__/helpers/http';
import { makePrDetailDto, makePr } from '../../../__tests__/helpers/prDetail';

// ---------------------------------------------------------------------------
// Live merge/close transition coverage, migrated from the deleted
// __tests__/PrDetailPage.transition.test.tsx (Task 5 routing swap). The
// transition-banner + auto-reload (#116) + "data &&" load-guard logic moved
// verbatim from PrDetailPageInner into PrDetailView, so it now mounts the view
// directly with a real EventStreamProvider + fetch mock instead of the old
// nested-route PrDetailPage shell.
// ---------------------------------------------------------------------------

// Leaf-tab data hooks the default Overview sub-tab pulls in. The transition
// tests exercise only the banners (driven by the REAL usePrDetail +
// useActivePrUpdates over the EventStreamProvider/fetch, left un-mocked), so the
// Overview leaf's own data hooks are stubbed to benign empty results to keep it
// from crashing on absent-backend fetches. (The old PrDetailPage.transition test
// used a stub <div> Overview route; PrDetailView renders the real OverviewTab.)
vi.mock('../../hooks/useFileDiff', () => ({
  useFileDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() }),
}));
vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities: null, error: null, refetch: vi.fn() }),
}));
vi.mock('../../hooks/useAiSummary', () => ({
  useAiSummary: () => ({ summary: null, loading: false, error: false }),
}));
vi.mock('../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => ({ state: 'empty', suggestions: null }),
}));

const openPrDto: PrDetailDto = makePrDetailDto({
  pr: makePr({ title: 'Refactor the renewal worker', author: 'amelia.cho', headSha: 'abc123' }),
  iterations: [
    { number: 1, beforeSha: 'a', afterSha: 'b', commits: [], hasResolvableRange: true },
    { number: 2, beforeSha: 'b', afterSha: 'abc123', commits: [], hasResolvableRange: true },
  ],
});

function mountView(fetchImpl?: typeof fetch) {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  return render(
    <MemoryRouter>
      <EventStreamProvider>
        <OpenTabsProvider>
          <AskAiDrawerProvider>
            <ToastProvider>
              <PrDetailView prRef={{ owner: 'octocat', repo: 'hello', number: 42 }} active={true} />
            </ToastProvider>
          </AskAiDrawerProvider>
        </OpenTabsProvider>
      </EventStreamProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installFakeEventSource();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PrDetailView — live merge/close transition banner', () => {
  it('shows the transition banner and hides BannerRefresh when the PR becomes merged', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(openPrDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    mountView(fetchMock as typeof fetch);
    await screen.findAllByText('Refactor the renewal worker');
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

    expect(await screen.findByText(/just merged/i)).toBeInTheDocument();
    expect(screen.getByText(/Reload to read-only view/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reload-banner')).not.toBeInTheDocument();
  });

  it('shows "just closed" copy when the PR becomes closed (not merged)', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(openPrDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    mountView(fetchMock as typeof fetch);
    await screen.findAllByText('Refactor the renewal worker');
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
    mountView(fetchMock as typeof fetch);
    await screen.findAllByText('Refactor the renewal worker');
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
    expect(screen.queryByLabelText(/dismiss banner/i)).not.toBeInTheDocument();
  });

  it('does NOT show the transition banner while detail is still loading (SSE done-event arrives before GET resolves)', async () => {
    // Guard: `data && !detailIsDone && updates.isMerged` — without the `data &&`
    // prefix, detailIsDone is false while data is null, causing the banner to
    // flash on an already-done PR mid-load. The fetch below never resolves.
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}, 204));
    });
    mountView(fetchMock as typeof fetch);
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

    expect(screen.queryByText(/just merged/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/just closed/i)).not.toBeInTheDocument();
  });

  it('does NOT show the transition banner when the loaded detail is already done (no live transition)', async () => {
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
    mountView(fetchMock as typeof fetch);
    await screen.findAllByText('Refactor the renewal worker');
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

    expect(screen.queryByText(/just merged/i)).not.toBeInTheDocument();
  });

  it('auto-reloads to read-only on a background merge without a manual Reload click (#116)', async () => {
    const mergedDto: PrDetailDto = {
      ...openPrDto,
      pr: {
        ...openPrDto.pr,
        state: 'merged',
        isMerged: true,
        mergedAt: '2026-06-03T12:00:00Z',
      },
    };
    let detailCalls = 0;
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') {
        detailCalls += 1;
        return Promise.resolve(jsonResponse(detailCalls === 1 ? openPrDto : mergedDto));
      }
      return Promise.resolve(jsonResponse({}, 204));
    });
    mountView(fetchMock as typeof fetch);
    await screen.findAllByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(detailCalls).toBe(1);

    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
        isMerged: true,
        isClosed: false,
      }),
    );

    await waitFor(() => expect(detailCalls).toBe(2));
    await waitFor(() => expect(screen.queryByText(/just merged/i)).not.toBeInTheDocument());
    expect(await screen.findByText(/^Merged/)).toBeInTheDocument();
    expect(detailCalls).toBe(2);
  });
});
