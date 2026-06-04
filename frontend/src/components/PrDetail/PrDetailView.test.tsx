import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import type { PrDetailDto, PrReference } from '../../api/types';
import { PrDetailView } from './PrDetailView';

// ---------------------------------------------------------------------------
// PrDetailView depends on the same data/SSE hooks PrDetailPageInner did. We
// mock them exactly as PrDetailPage.tabbing.test.tsx does, returning ready
// data so the sub-tabs render (the keep-alive behavior under test is pure
// component state, independent of any network result).
// ---------------------------------------------------------------------------

const PR_DETAIL: PrDetailDto = {
  pr: {
    reference: { owner: 'acme', repo: 'api', number: 7 },
    title: 'Keep-alive title',
    body: 'A realistic body.',
    author: 'alice',
    state: 'open',
    headSha: 'abc123',
    baseSha: 'def456',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: '',
    isMerged: false,
    isClosed: false,
    openedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    mergedAt: null,
    closedAt: null,
  },
  clusteringQuality: 'ok',
  iterations: [],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

vi.mock('../../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: PR_DETAIL,
    showSkeleton: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDraftSession', () => ({
  useDraftSession: () => ({
    session: { draftComments: [], draftReplies: [], draftVerdictStatus: 'none' },
    status: 'ready',
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    registerOpenComposer: vi.fn(() => () => {}),
    getPrRootHolder: vi.fn(() => null),
    outOfBandToast: null,
    clearOutOfBandToast: vi.fn(),
  }),
}));

vi.mock('../../hooks/useActivePrUpdates', () => ({
  useActivePrUpdates: () => ({
    hasUpdate: false,
    headShaChanged: false,
    commentCountDelta: 0,
    isMerged: false,
    isClosed: false,
    clear: vi.fn(),
  }),
}));

vi.mock('../../hooks/useStateChangedSubscriber', () => ({
  useStateChangedSubscriber: () => {},
}));

vi.mock('../../hooks/useRootCommentPostedSubscriber', () => ({
  useRootCommentPostedSubscriber: () => {},
}));

vi.mock('../../hooks/useCrossTabPrPresence', () => ({
  useCrossTabPrPresence: () => ({
    readOnly: false,
    showBanner: false,
    switchToOther: vi.fn(),
    takeOver: vi.fn(),
    dismissForSession: vi.fn(),
  }),
}));

vi.mock('../../hooks/useReconcile', () => ({
  useReconcile: () => ({
    reload: vi.fn().mockResolvedValue(undefined),
    banner: null,
    clearBanner: vi.fn(),
  }),
}));

// Leaf-tab data hooks fire async fetches against an absent backend. Stub them
// to benign empty results so the real OverviewTab/FilesTab/DraftsTab render
// deterministically (the keep-alive assertions don't depend on their content).
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() }),
}));
vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities: null, error: null, refetch: vi.fn() }),
}));
vi.mock('../../hooks/useFileDiff', () => ({
  useFileDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/useAiSummary', () => ({
  useAiSummary: () => null,
}));
vi.mock('../../hooks/useAiFileFocus', () => ({
  useAiFileFocus: () => null,
}));
vi.mock('../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => null,
}));
vi.mock('../../hooks/useFilesTabShortcuts', () => ({
  useFilesTabShortcuts: () => {},
}));
vi.mock('../../hooks/useFirstActivePrPollComplete', () => ({
  useFirstActivePrPollComplete: () => true,
}));

function renderPrDetailView({ prRef }: { prRef: PrReference }) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <AskAiDrawerProvider>
          <ToastProvider>
            <PrDetailView prRef={prRef} active={true} />
          </ToastProvider>
        </AskAiDrawerProvider>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('PrDetailView', () => {
  test('sub-tab selection is component state; visited sub-tabs stay mounted hidden', async () => {
    renderPrDetailView({ prRef: { owner: 'acme', repo: 'api', number: 7 } });
    expect(screen.getByTestId('overview-tab')).toBeVisible();
    expect(screen.queryByTestId('files-tab-root')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('pr-tab-files'));
    expect(screen.getByTestId('files-tab-root')).toBeVisible();

    await userEvent.click(screen.getByTestId('pr-tab-overview'));
    expect(screen.getByTestId('overview-tab')).toBeVisible();
    const files = screen.getByTestId('files-tab-root');
    expect(files).toBeInTheDocument();
    expect(files.closest('[data-subtab="files"]')).toHaveAttribute('hidden');

    expect(screen.queryByTestId('drafts-tab-root')).not.toBeInTheDocument();
  });
});
