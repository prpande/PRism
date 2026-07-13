import { describe, test, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { App } from '../../App';
import { makePrDetailDto, makePr } from '../../../__tests__/helpers/prDetail';
import { PrTabHost, parsePrRoute } from './PrTabHost';
import { OpenTabsContext, type OpenTabsContextValue } from '../../contexts/OpenTabsContext';
import { ToastProvider } from '../../components/Toast';
import { CheatsheetProvider } from '../../components/Cheatsheet';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import type { ReviewSessionDto } from '../../api/types';

// ---------------------------------------------------------------------------
// Keep-alive host integration test. We mount the REAL <App/> (its provider tree
// + the <PrTabHost/> + <Routes> shape) inside a MemoryRouter, mocking the
// data/SSE hooks the PR-detail views depend on (the same set PrDetailView.test
// mocks) plus the auth/inbox hooks so the inbox + a ready PR view both render.
// The assertion under test — a view stays mounted-but-hidden across navigation
// and its state survives a return — is pure routing/keep-alive behavior,
// independent of any network result.
// ---------------------------------------------------------------------------

const PR_DETAIL = makePrDetailDto({
  pr: makePr({ reference: { owner: 'acme', repo: 'api', number: 7 }, title: 'Keep-alive title' }),
});

// Auth: token present so the authed routes (Inbox + PrTabHost) mount.
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    authState: { hasToken: true, host: 'https://github.com', hostMismatch: null },
    error: null,
    refetch: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Inbox renders with empty-but-ready data. Hoist to a stable object so the
// reference matches the real `useInbox` (which holds `data` in `useState`):
// a per-call factory would hand the authed InboxPage a fresh `sections` array
// each render, re-firing FilterBar's onState effect → setState → re-render → loop.
const inboxSnapshot = vi.hoisted(() => ({
  data: {
    sections: [] as never[],
    enrichments: {},
    lastRefreshedAt: '',
    tokenScopeFooterEnabled: false,
    ciProbeComplete: true,
    stale: false,
  },
  isLoading: false,
  error: null,
  reload: vi.fn(),
}));
vi.mock('../../hooks/useInbox', () => ({
  useInbox: () => inboxSnapshot,
}));
vi.mock('../../hooks/useInboxUpdates', () => ({
  useInboxUpdates: () => ({ announce: '' }),
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
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDraftSession', async (importOriginal) => ({
  // Spread the real module so pure exports (computeAnyOtherDraftsStaged,
  // called by FilesTab at render time) stay live; only the hook is faked.
  ...(await importOriginal<typeof import('../../hooks/useDraftSession')>()),
  useDraftSession: () => ({
    session: {
      draftVerdict: null,
      draftVerdictStatus: 'draft',
      draftComments: [],
      draftReplies: [],
      iterationOverrides: [],
      pendingReviewId: null,
      pendingReviewCommitOid: null,
      fileViewState: { viewedFiles: {} },
    } satisfies ReviewSessionDto,
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
vi.mock('../../hooks/useAiSummary', () => ({
  useAiSummary: () => ({ summary: null, loading: false, error: false }),
}));
vi.mock('../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => ({ state: 'empty', suggestions: null }),
}));
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

  test('navigating to an invalid PR URL shows an alert but keeps open tabs mounted', async () => {
    // Deep-link the Files sub-tab so the Files view is mounted (visited) up front.
    const { navigate } = renderAppAt('/pr/acme/api/7/files');
    await screen.findByTestId('files-tab-root');
    expect(screen.getByTestId('files-tab-root')).toBeVisible();

    // Malformed number segment → invalid route. The error dialog must render
    // WITHOUT unmounting the kept-alive PR#7 view (whose state would otherwise
    // be lost). The invalid-ref error is now an ErrorModal alertdialog.
    navigate('/pr/acme/api/0');
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/positive integer/i);
    expect(screen.getByTestId('files-tab-root')).toBeInTheDocument(); // survived
    expect(
      screen.getByTestId('files-tab-root').closest('[data-prref="acme/api/7"]'),
    ).toHaveAttribute('hidden');

    // Returning to the valid URL re-activates the same mounted view.
    navigate('/pr/acme/api/7/files');
    expect(screen.getByTestId('files-tab-root')).toBeVisible();
  });

  test('a hidden (inactive) PR view has no focusable element in the tab order', async () => {
    const { navigate } = renderAppAt('/pr/acme/api/7');
    // Make the first view real + visited so it has focusable chrome (open Files).
    await userEvent.click(await screen.findByTestId('pr-tab-files'));
    expect(screen.getByTestId('files-tab-root')).toBeVisible();

    // Open a second PR tab — #7 becomes hidden, #8 active.
    navigate('/pr/acme/api/8');
    // Wait for the second view to mount and the first to flip to hidden.
    // Scope to [data-app-scroll] to avoid matching the PrTabStrip pill which
    // also carries data-prref but never gets the hidden attribute.
    const scroll = document.querySelector('[data-app-scroll]')!;
    await waitFor(() => {
      const el = scroll.querySelector('[data-prref="acme/api/7"]');
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute('hidden');
    });

    // waitFor above already proved the hidden view exists and carries [hidden];
    // re-grab the element handle for the focusable-descendant sweep below.
    const hidden = scroll.querySelector('[data-prref="acme/api/7"]') as HTMLElement;

    // Teeth: the hidden view must actually CONTAIN focusable elements, else the
    // forEach below is vacuously true. The query intentionally over-approximates
    // the keyboard tab order: it also matches tabindex="-1" (script-focusable but
    // NOT tab-order) elements. That's a stronger guarantee, not a bug — [hidden]
    // removes BOTH keyboard-focusable (tabindex>=0) and script-focusable
    // (tabindex=-1) descendants from the tab order and the a11y tree.
    const focusables = hidden.querySelectorAll(
      'button, a[href], input, select, textarea, [tabindex]',
    );
    expect(focusables.length).toBeGreaterThan(0);

    // Every focusable descendant is inside a [hidden] subtree → out of tab order
    // + a11y tree (the inactive view's root carries [hidden]).
    focusables.forEach((el) => {
      expect(el.closest('[hidden]')).not.toBeNull();
    });

    // Sanity: the active view (#8) is NOT hidden.
    const active = scroll.querySelector('[data-prref="acme/api/8"]') as HTMLElement;
    expect(active).not.toBeNull();
    expect(active).not.toHaveAttribute('hidden');
  });

  test('renders the active PR view on direct load even before addTab populates openTabs', () => {
    // Regression: on a cold direct load (refresh / deep link) openTabs is empty
    // on first paint and addTab only runs post-render. Stub addTab to a no-op so
    // openTabs NEVER gains the entry — the view must still render, proving the
    // host unions the active route ref into the mounted set rather than waiting
    // on the effect (which would flash blank).
    const stub: OpenTabsContextValue = {
      openTabs: [],
      unreadKeys: new Set<string>(),
      addTab: vi.fn(),
      setTitle: vi.fn(),
      setTabState: vi.fn(),
      closeTab: vi.fn(),
      clearAllTabs: vi.fn(),
      markUnread: vi.fn(),
      clearUnread: vi.fn(),
    };
    render(
      <ToastProvider>
        <CheatsheetProvider>
          <OpenTabsContext.Provider value={stub}>
            <AskAiDrawerProvider>
              <MemoryRouter initialEntries={['/pr/acme/api/7']}>
                <PrTabHost />
              </MemoryRouter>
            </AskAiDrawerProvider>
          </OpenTabsContext.Provider>
        </CheatsheetProvider>
      </ToastProvider>,
    );
    expect(document.querySelector('[data-prref="acme/api/7"]')).toBeInTheDocument();
    expect(stub.addTab).toHaveBeenCalled(); // effect still tries to register it
  });
});

describe('parsePrRoute', () => {
  test('parses a valid PR path and defaults the sub-tab to overview', () => {
    expect(parsePrRoute('/pr/acme/api/7')).toEqual({
      ref: { owner: 'acme', repo: 'api', number: 7 },
      valid: true,
      subTab: 'overview',
    });
  });

  test('extracts files/hotspots/drafts sub-tab segments and clamps unknown ones to overview', () => {
    expect(parsePrRoute('/pr/acme/api/7/files')?.subTab).toBe('files');
    expect(parsePrRoute('/pr/acme/api/7/hotspots')?.subTab).toBe('hotspots');
    expect(parsePrRoute('/pr/acme/api/7/drafts')?.subTab).toBe('drafts');
    expect(parsePrRoute('/pr/acme/api/7/garbage')?.subTab).toBe('overview');
  });

  test('normalizes a zero-padded number (GitHub-consistent)', () => {
    const r = parsePrRoute('/pr/acme/api/042');
    expect(r?.valid).toBe(true);
    expect(r?.ref.number).toBe(42);
  });

  test.each(['/pr/acme/api/0x1f', '/pr/acme/api/1e3', '/pr/acme/api/12abc', '/pr/acme/api/0'])(
    'rejects non-decimal / non-positive number segment %s as invalid',
    (path) => {
      // The digit guard prevents Number()'s permissive hex/exponent/NaN parsing
      // from mapping a malformed URL onto a real (or bogus) PR.
      expect(parsePrRoute(path)?.valid).toBe(false);
    },
  );

  test('returns null when the path is not a /pr/ route', () => {
    expect(parsePrRoute('/')).toBeNull();
    expect(parsePrRoute('/inbox')).toBeNull();
  });
});
