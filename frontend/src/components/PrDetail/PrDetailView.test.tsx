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
import type { PrReference } from '../../api/types';
import { prRefKey } from '../../api/types';
import { makePrDetailDto, makePr } from '../../../__tests__/helpers/prDetail';
import type { PrTabId } from './PrSubTabStrip';
import { PrDetailView } from './PrDetailView';
import * as prDetailApi from '../../api/prDetail';

// #344 — observe the usePrDetail.reload() that the refresh hook fires. The
// usePrDetail mock is fully stubbed (no getPrDetail spy), so a hoisted, stable
// reload mock is the only way to assert the post-refresh re-GET. Declared via
// vi.hoisted so it exists before the vi.mock factory below references it.
const { reloadMock } = vi.hoisted(() => ({ reloadMock: vi.fn() }));

// ---------------------------------------------------------------------------
// PrDetailView depends on the same data/SSE hooks PrDetailPageInner did. We
// mock them exactly as PrDetailPage.tabbing.test.tsx does, returning ready
// data so the sub-tabs render (the keep-alive behavior under test is pure
// component state, independent of any network result).
// ---------------------------------------------------------------------------

const PR_DETAIL = makePrDetailDto({
  pr: makePr({
    reference: { owner: 'acme', repo: 'api', number: 7 },
    title: 'Keep-alive title',
    author: 'alice',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  }),
});

vi.mock('../../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: PR_DETAIL,
    isLoading: false,
    error: null,
    reload: reloadMock,
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

vi.mock('../../hooks/useDraftSubmittedSubscriber', () => ({
  useDraftSubmittedSubscriber: () => {},
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
vi.mock('../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => ({ state: 'empty', suggestions: null }),
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
// Task 8 (#344) — manual Refresh wiring. The header Refresh button drives the
// real usePrDetailRefresh hook (the ONLY refresh hook not mocked here), which
// posts /refresh via the spied refreshPrDetail and then fires usePrDetail.reload
// (the hoisted reloadMock). usePrDetail is fully stubbed, so we assert on the
// spy + reloadMock rather than a getPrDetail call.
// ---------------------------------------------------------------------------
describe('PrDetailView — manual Refresh wiring (Task 8 / #344)', () => {
  const PR = { owner: 'acme', repo: 'api', number: 7 };

  beforeEach(() => {
    vi.restoreAllMocks();
    reloadMock.mockClear();
  });

  test('clicking Refresh posts /refresh then reloads the detail', async () => {
    const refreshSpy = vi.spyOn(prDetailApi, 'refreshPrDetail').mockResolvedValue(undefined);

    renderPrDetailView({ prRef: PR });

    await userEvent.click(screen.getByTestId('pr-refresh-button'));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(refreshSpy).toHaveBeenCalledWith(PR, expect.any(AbortSignal));
    await waitFor(() => expect(reloadMock).toHaveBeenCalled());
  });

  test('shows the per-tab loading bar during an in-flight refresh (initial load already settled)', async () => {
    // Never-resolving refresh → isRefreshing stays true while isLoading is
    // already false. Proves the LoadingBar `active={active && (isLoading ||
    // prRefresh.isRefreshing)}` term is wired (guards the `|| isRefreshing`).
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockImplementation(() => new Promise<void>(() => {}));

    renderPrDetailView({ prRef: PR });

    await userEvent.click(screen.getByTestId('pr-refresh-button'));

    await waitFor(() =>
      expect(screen.getByTestId(`pr-loading-bar:${prRefKey(PR)}`)).toHaveAttribute(
        'data-active',
        'true',
      ),
    );
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
  const setTabStateSpy = vi.fn();

  const openTabsStub: OpenTabsContextValue = {
    openTabs: [],
    unreadKeys: new Set<string>(),
    addTab: vi.fn(),
    setTitle: setTitleSpy,
    setTabState: setTabStateSpy,
    closeTab: vi.fn(),
    markUnread: vi.fn(),
    clearUnread: vi.fn(),
    clearAllTabs: vi.fn(),
  };

  beforeEach(() => {
    setTitleSpy.mockClear();
    setTabStateSpy.mockClear();
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

  test('setTabState is called with the resolved PR glyph state (#530)', async () => {
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
      // PR_DETAIL is open (isMerged/isClosed/isDraft all false) → 'open' glyph.
      expect(setTabStateSpy).toHaveBeenCalledWith(
        { owner: 'acme', repo: 'api', number: 7 },
        'open',
      );
    });
  });
});
