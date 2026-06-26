import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PrDetailView } from '../src/components/PrDetail/PrDetailView';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { OpenTabsProvider } from '../src/contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../src/contexts/AskAiDrawerContext';
import { ToastProvider } from '../src/components/Toast/useToast';
import type { PrDetailDto } from '../src/api/types';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';
import { jsonResponse } from './helpers/http';
import { makePrDetailDto, makePr } from './helpers/prDetail';

// ---------------------------------------------------------------------------
// #566: PrDetailView lifecycle subscriber + banner-suppression wiring.
//
// These tests exercise only the transition-banner logic (driven by the REAL
// usePrDetail + useActivePrUpdates + useLifecycleChangedSubscriber over a live
// EventStreamProvider + fetch mock). Leaf-tab data hooks are stubbed to benign
// empty results so the OverviewTab doesn't crash on absent-backend fetches.
// ---------------------------------------------------------------------------

vi.mock('../src/hooks/useFileDiff', () => ({
  useFileDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../src/hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() }),
}));
vi.mock('../src/hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities: null, error: null, refetch: vi.fn() }),
}));
vi.mock('../src/hooks/useAiSummary', () => ({
  useAiSummary: () => ({ summary: null, loading: false, error: false }),
}));
vi.mock('../src/hooks/useAiDraftSuggestions', () => ({
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

describe('PrDetailView — lifecycle subscriber + banner suppression (#566)', () => {
  it('a self lifecycle action clears the update latch and does not flash the transition banner', async () => {
    // Arrange: render with an open PR loaded. Every other fetch returns 204.
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/pr/octocat/hello/42') return Promise.resolve(jsonResponse(openPrDto));
      return Promise.resolve(jsonResponse({}, 204));
    });
    mountView(fetchMock as typeof fetch);

    // Wait for the PR to load and the SSE stream to open.
    await screen.findAllByText('Refactor the renewal worker');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // Step 1: a background pr-updated latches isClosed=true on the acting tab.
    // With no clear(), this would show BannerTransition("closed").
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: true,
      }),
    );
    // Confirm the banner actually appeared (prerequisite for the suppression check).
    expect(await screen.findByText(/just closed/i)).toBeInTheDocument();

    // Step 2: the user's own lifecycle action (close/reopen/draft toggle) fires
    // pr-lifecycle-changed. handleLifecycleChanged must call updates.clear() BEFORE
    // reload() so the acting tab does NOT flash the "PR was just closed" banner
    // for its own action.
    act(() =>
      FakeEventSource.instance.dispatch('pr-lifecycle-changed', {
        prRef: 'octocat/hello/42',
      }),
    );

    // Assert: the transition banner is gone. updates.clear() ran synchronously,
    // clearing isClosed before the reload could re-latch it.
    await waitFor(() => expect(screen.queryByText(/just closed/i)).not.toBeInTheDocument());
  });
});
