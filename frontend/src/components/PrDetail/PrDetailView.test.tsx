import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  OpenTabsProvider,
  OpenTabsContext,
  type OpenTabsContextValue,
} from '../../contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import type { PrDetailDto, PrReference } from '../../api/types';
import type { PrTabId } from './PrSubTabStrip';
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
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
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
    isLoading: false,
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
    subscribed: true,
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
  useAiSummary: () => ({ summary: null, loading: false, error: false }),
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

function renderPrDetailView({
  prRef,
  initialSubTab,
}: {
  prRef: PrReference;
  initialSubTab?: PrTabId;
}) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <AskAiDrawerProvider>
          <ToastProvider>
            <PrDetailView prRef={prRef} active={true} initialSubTab={initialSubTab} />
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

  // #173 — landing on a non-overview sub-tab must NOT pre-mount the hidden
  // Overview tab. Pre-seeding 'overview' into `visited` mounted a hidden
  // OverviewTab whose auto-opened PR-root composer claimed the draft and
  // disabled the Submit dialog's inline Edit toggle from the Files tab. The
  // fix seeds `visited` with only the landed sub-tab, so Overview is absent
  // from the DOM until first visit. (E2E S-dialog 2/3 cover the full lock
  // behavior; this is the fast unit-level guard on the seeding logic.)
  test('initialSubTab="files" does not pre-mount the Overview tab', () => {
    renderPrDetailView({
      prRef: { owner: 'acme', repo: 'api', number: 7 },
      initialSubTab: 'files',
    });
    expect(screen.queryByTestId('overview-tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-tab-root')).toBeVisible();
  });

  // #127 — the lg author avatar renders in the PR header (the only render site
  // without a dedicated per-site test; flagged by claude[bot] on PR #188).
  test('renders the author avatar in the PR header next to the author', () => {
    renderPrDetailView({ prRef: { owner: 'acme', repo: 'api', number: 7 } });
    const header = screen.getByTestId('pr-header');
    expect(header.querySelector('[data-testid="avatar"]')).not.toBeNull();
    expect(header.textContent).toContain('alice');
  });
});

// ---------------------------------------------------------------------------
// Task 11 — title-on-resolve: when usePrDetail resolves with a PR title, the
// view must propagate it into the open-tab entry via setTitle.
//
// This restores coverage that existed in the deleted PrDetailPage.tabbing.test.tsx
// (the "direct URL load" title assertion) but re-targets the new state-based
// architecture. The OpenTabsContext seam is used (same pattern as
// PrDetailView.freshness.test.tsx) to supply a setTitle spy without involving
// the real provider. The module-level usePrDetail mock above already returns
// PR_DETAIL with title 'Keep-alive title' and reference acme/api#7, which is
// exactly the resolved data the effect needs.
// ---------------------------------------------------------------------------
describe('PrDetailView — title propagation on resolve (Task 11)', () => {
  const setTitleSpy = vi.fn();

  const openTabsStub: OpenTabsContextValue = {
    openTabs: [],
    unreadKeys: new Set<string>(),
    addTab: vi.fn(),
    setTitle: setTitleSpy,
    closeTab: vi.fn(),
    markUnread: vi.fn(),
    clearUnread: vi.fn(),
    clearAllTabs: vi.fn(),
  };

  beforeEach(() => {
    setTitleSpy.mockClear();
  });

  test('setTitle is called with prRef and resolved title when usePrDetail resolves', async () => {
    render(
      <MemoryRouter>
        <OpenTabsContext.Provider value={openTabsStub}>
          <AskAiDrawerProvider>
            <ToastProvider>
              <PrDetailView prRef={{ owner: 'acme', repo: 'api', number: 7 }} active={true} />
            </ToastProvider>
          </AskAiDrawerProvider>
        </OpenTabsContext.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      // Exactly once — also catches a double-fire from a misconfigured effect
      // deps array (the title effect must run a single time on resolve).
      expect(setTitleSpy).toHaveBeenCalledTimes(1);
      expect(setTitleSpy).toHaveBeenCalledWith(
        { owner: 'acme', repo: 'api', number: 7 },
        'Keep-alive title',
      );
    });
  });
});
