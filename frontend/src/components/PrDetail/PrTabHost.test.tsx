import { describe, test, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { PrDetailDto } from '../../api/types';
import { App } from '../../App';

// ---------------------------------------------------------------------------
// Keep-alive host integration test. We mount the REAL <App/> (its provider tree
// + the <PrTabHost/> + <Routes> shape) inside a MemoryRouter, mocking the
// data/SSE hooks the PR-detail views depend on (the same set PrDetailView.test
// mocks) plus the auth/inbox hooks so the inbox + a ready PR view both render.
// The assertion under test — a view stays mounted-but-hidden across navigation
// and its state survives a return — is pure routing/keep-alive behavior,
// independent of any network result.
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

// Auth: token present so the authed routes (Inbox + PrTabHost) mount.
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    authState: { hasToken: true, host: 'https://github.com', hostMismatch: null },
    error: null,
    refetch: vi.fn(),
    connect: vi.fn(),
  }),
}));

// Inbox renders with empty-but-ready data.
vi.mock('../../hooks/useInbox', () => ({
  useInbox: () => ({
    data: { sections: [], enrichments: {}, lastRefreshedAt: '', tokenScopeFooterEnabled: false },
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));
vi.mock('../../hooks/useInboxUpdates', () => ({
  useInboxUpdates: () => ({ hasUpdate: false, summary: '', dismiss: vi.fn() }),
}));

// SSE provider is a passthrough; no live event channel in the unit test.
vi.mock('../../hooks/useEventSource', () => ({
  EventStreamProvider: ({ children }: { children: React.ReactNode }) => children,
  useEventSource: () => null,
}));

// PR-detail data hooks — ready data so the view mounts immediately.
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
vi.mock('../../hooks/useTabUnreadSignal', () => ({
  useTabUnreadSignal: () => {},
}));

// Leaf-tab data hooks fire async fetches against an absent backend. Stub them
// to benign empty results so the real OverviewTab/FilesTab/DraftsTab render
// deterministically.
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
vi.mock('../../hooks/useAiSummary', () => ({ useAiSummary: () => null }));
vi.mock('../../hooks/useAiFileFocus', () => ({ useAiFileFocus: () => null }));
vi.mock('../../hooks/useAiDraftSuggestions', () => ({ useAiDraftSuggestions: () => null }));
vi.mock('../../hooks/useFilesTabShortcuts', () => ({ useFilesTabShortcuts: () => {} }));
vi.mock('../../hooks/useFirstActivePrPollComplete', () => ({
  useFirstActivePrPollComplete: () => true,
}));

let navigateRef: ((to: string) => void) | null = null;
function NavProbe() {
  navigateRef = useNavigate();
  return null;
}

function renderAppAt(path: string) {
  navigateRef = null;
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavProbe />
      <App />
    </MemoryRouter>,
  );
  const navigate = (to: string) => {
    act(() => navigateRef!(to));
  };
  return { navigate };
}

describe('PrTabHost', () => {
  test('host keeps PR views mounted across navigation', async () => {
    const { navigate } = renderAppAt('/pr/acme/api/7');
    await userEvent.click(await screen.findByTestId('pr-tab-files'));
    expect(screen.getByTestId('files-tab-root')).toBeVisible();

    navigate('/');
    expect(screen.getByTestId('inbox-page')).toBeVisible();
    expect(screen.getByTestId('files-tab-root')).toBeInTheDocument(); // kept alive
    expect(
      screen.getByTestId('files-tab-root').closest('[data-prref="acme/api/7"]'),
    ).toHaveAttribute('hidden');

    navigate('/pr/acme/api/7');
    expect(screen.getByTestId('files-tab-root')).toBeVisible(); // state survived
  });
});
