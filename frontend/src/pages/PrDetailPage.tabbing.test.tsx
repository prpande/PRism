import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../contexts/OpenTabsContext';
import { PrDetailPage } from './PrDetailPage';

vi.mock('../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: {
      pr: {
        reference: { owner: 'acme', repo: 'api', number: 42 },
        title: 'Direct-link title',
        author: 'alice',
        state: 'open',
        headSha: 'abc',
        baseSha: 'def',
        headBranch: 'feat',
        baseBranch: 'main',
        mergeability: 'mergeable',
        ciSummary: '',
        isMerged: false,
        isClosed: false,
        openedAt: new Date().toISOString(),
      },
      iterations: [],
    },
    showSkeleton: false,
    error: null,
    reload: () => {},
  }),
}));

vi.mock('../hooks/useDraftSession', () => ({
  useDraftSession: () => ({
    session: { draftComments: [], draftReplies: [] },
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock('../hooks/useActivePrUpdates', () => ({
  useActivePrUpdates: () => ({
    hasUpdate: false,
    headShaChanged: false,
    commentCountDelta: 0,
    clear: () => {},
  }),
}));
vi.mock('../hooks/useStateChangedSubscriber', () => ({
  useStateChangedSubscriber: () => {},
}));
vi.mock('../hooks/useCrossTabPrPresence', () => ({
  useCrossTabPrPresence: () => ({
    readOnly: false,
    showBanner: false,
    switchToOther: () => {},
    takeOver: () => {},
    dismissForSession: () => {},
  }),
}));
vi.mock('../hooks/useReconcile', () => ({
  useReconcile: () => ({
    reload: () => Promise.resolve(),
    banner: null,
    clearBanner: () => {},
  }),
}));

function Probe() {
  const { openTabs } = useOpenTabs();
  return (
    <div data-testid="tabs">
      {openTabs
        .map((t) => `${t.ref.owner}/${t.ref.repo}#${t.ref.number}=${t.title ?? 'null'}`)
        .join(',')}
    </div>
  );
}

describe('PrDetailPage on direct URL load', () => {
  it('adds an openTab and sets its title once usePrDetail resolves', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/42']}>
        <OpenTabsProvider>
          <Probe />
          <Routes>
            <Route path="/pr/:owner/:repo/:number" element={<PrDetailPage />}>
              <Route index element={<div>Overview</div>} />
            </Route>
          </Routes>
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('tabs').textContent).toContain('acme/api#42=Direct-link title'),
    );
  });
});
