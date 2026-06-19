import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboxResponse, AiCapabilities, PreferencesResponse } from '../api/types';
import { InboxPage } from './InboxPage';
import { OpenTabsProvider } from '../contexts/OpenTabsContext';

vi.mock('../hooks/useInbox', () => ({
  useInbox: vi.fn(),
}));
vi.mock('../components/Ai/AiOnboardingDialog', () => ({
  AiOnboardingDialog: ({ onDismiss }: { onDismiss: () => void }) => (
    <div data-testid="onboarding-dialog" onClick={onDismiss} />
  ),
}));
vi.mock('../hooks/useInboxUpdates', () => ({
  useInboxUpdates: vi.fn(),
}));
vi.mock('../hooks/useCapabilities', () => ({
  useCapabilities: vi.fn(),
}));
vi.mock('../hooks/usePreferences', () => ({
  usePreferences: vi.fn(),
}));
vi.mock('../hooks/useAiGate', () => ({
  useAiGate: vi.fn(),
  useIsSampleMode: () => false,
}));

import { useInbox } from '../hooks/useInbox';
import { useInboxUpdates } from '../hooks/useInboxUpdates';
import { useCapabilities } from '../hooks/useCapabilities';
import { usePreferences } from '../hooks/usePreferences';
import { useAiGate } from '../hooks/useAiGate';

// The global setup mock returns matches:false. The rail now also requires a
// >=1180px viewport, so rail-visible tests must opt into a wide viewport.
const realMatchMedia = window.matchMedia;
function mockViewportWide(wide: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: wide,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
beforeEach(() => {
  window.matchMedia = realMatchMedia; // reset to the setup default (matches:false) per test
});

function setHooks(
  opts: {
    data?: InboxResponse | null;
    isLoading?: boolean;
    error?: unknown;
    aiPreview?: boolean;
    inboxEnrichment?: boolean;
    // #283 the ActivityRail is gated on preferences.inbox.showActivityRail (default false),
    // decoupled from the AI-preview toggle.
    showActivityRail?: boolean;
    sectionOrder?: string;
  } = {},
) {
  const reload = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useInbox).mockReturnValue({
    data: opts.data ?? null,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
    reload,
  });
  vi.mocked(useInboxUpdates).mockReturnValue({ announce: '' });
  // InboxPage uses useAiGate for the AI gates, and calls usePreferences directly for
  // the initial sort + activity-rail visibility, so its mock below is load-bearing.
  // useCapabilities is NOT called directly (only transitively via useAiGate, which is
  // mocked per-test); its registration is kept so the transitive mock chain stays
  // satisfied and no "unmocked module" warning fires from other test paths.
  vi.mocked(useCapabilities).mockReturnValue({
    capabilities: {
      inboxEnrichment: opts.inboxEnrichment ?? false,
    } as AiCapabilities,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(usePreferences).mockReturnValue({
    preferences: {
      ui: {
        theme: 'system',
        accent: 'indigo',
        aiMode: 'off',
        density: 'comfortable',
        contentScale: 'm',
      },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'recently-closed': true,
        },
        defaultSort: 'updated',
        sectionOrder:
          opts.sectionOrder ?? 'review-requested,awaiting-author,authored-by-me,mentioned',
        showActivityRail: opts.showActivityRail ?? false,
        groupByRepo: true,
      },
      github: {
        host: 'https://github.com',
        configPath: '/fake/config.json',
        logsPath: '/fake/logs',
      },
    } as PreferencesResponse,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  });
  // #283 useAiGate only gates the category chip now (inboxEnrichment). The ActivityRail
  // is gated on preferences.inbox.showActivityRail above, not via useAiGate.
  vi.mocked(useAiGate).mockImplementation((key) => {
    if (key === 'inboxEnrichment') return opts.inboxEnrichment ?? false;
    return false;
  });
  return { reload };
}

const sampleData: InboxResponse = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [
        {
          reference: { owner: 'acme', repo: 'api', number: 42 },
          title: 'Test PR',
          author: 'amelia',
          repo: 'acme/api',
          updatedAt: new Date().toISOString(),
          pushedAt: new Date().toISOString(),
          iterationNumber: 1,
          commentCount: 0,
          additions: 5,
          deletions: 2,
          headSha: 'abc',
          ci: 'none' as const,
          lastViewedHeadSha: null,
          lastSeenCommentId: null,
          mergedAt: null,
          closedAt: null,
          isDraft: false,
        },
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: new Date().toISOString(),
  tokenScopeFooterEnabled: true,
  ciProbeComplete: true,
};

const emptyData: InboxResponse = {
  ...sampleData,
  sections: [{ id: 'review-requested', label: 'Review requested', items: [] }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <OpenTabsProvider>
        <InboxPage />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('InboxPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the content-shaped skeleton (not a spinner) while fetching first snapshot', () => {
    setHooks({ data: null, isLoading: true });
    renderPage();
    const skeleton = screen.getByTestId('inbox-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(within(skeleton).getByText(/loading inbox/i)).toBeInTheDocument();
    // The per-surface loading bar shows alongside the skeleton.
    expect(screen.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'true');
  });

  it('cold-load skeleton hides its rail column below the 1180px breakpoint', () => {
    // #300 the skeleton's rail column is gated on the SAME showRail as the live rail,
    // so a narrow viewport drops it even with the toggle on.
    mockViewportWide(false);
    setHooks({ data: null, isLoading: true, showActivityRail: true });
    renderPage();
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-skeleton-rail')).not.toBeInTheDocument();
  });

  it('cold-load skeleton shows its rail column when wide and the toggle is on', () => {
    mockViewportWide(true);
    setHooks({ data: null, isLoading: true, showActivityRail: true });
    renderPage();
    expect(screen.getByTestId('inbox-skeleton-rail')).toBeInTheDocument();
  });

  it('shows error state with retry button when initial fetch fails', () => {
    setHooks({ data: null, isLoading: false, error: new Error('boom') });
    renderPage();
    expect(screen.getByText(/couldn.t load inbox/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('renders sections + rows when data is present', () => {
    setHooks({ data: sampleData });
    renderPage();
    expect(screen.getByText('Review requested')).toBeInTheDocument();
    expect(screen.getByText('Test PR')).toBeInTheDocument();
  });

  it('shows the loading bar (not a skeleton) over present data during a background reload', () => {
    // data present + isLoading: the bar signals the in-flight refresh at the
    // content top; the content-shaped skeleton must NOT flash over good data.
    setHooks({ data: sampleData, isLoading: true });
    renderPage();
    expect(screen.getByText('Test PR')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-skeleton')).toBeNull();
    expect(screen.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'true');
  });

  it('shows empty hint when every section is empty', () => {
    setHooks({ data: emptyData });
    renderPage();
    expect(screen.getByText(/nothing in your inbox right now/i)).toBeInTheDocument();
  });

  it('wires the inbox reload as the auto-refresh onUpdate (no banner) — #450', () => {
    // #450 the reload banner is gone; an inbox-updated frame now triggers a silent
    // auto-refresh. InboxPage delegates that to useInboxUpdates({ onUpdate: reload }).
    // The debounce + coalescing mechanics are covered in useInboxUpdates' own test
    // (__tests__/useInboxUpdates.test.tsx); here we lock the page-level wiring:
    // the page hands its inbox `reload` to the hook, and invoking that callback
    // re-fetches the inbox.
    const { reload } = setHooks({ data: sampleData });
    renderPage();

    // No banner / Reload affordance survives.
    expect(screen.queryByText(/new updates/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();

    // The hook received the inbox reload as its onUpdate.
    const onUpdate = vi.mocked(useInboxUpdates).mock.calls.at(-1)?.[0]?.onUpdate;
    expect(onUpdate).toBe(reload);

    // Firing it (as the debounced hook would, post-500ms) re-fetches the inbox.
    expect(reload).not.toHaveBeenCalled();
    void onUpdate?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('announces auto-refresh in its own live region (not masked by the sticky manual announce) — #450', () => {
    // useInboxRefresh.announce is sticky ('Inbox refreshed' until the next error), so a single
    // `{announce || autoRefresh.announce}` region would let it permanently mask the auto-refresh
    // signal once the user has manually refreshed even once. The auto-refresh announcement lives
    // in its OWN role=status region so it is always announced.
    setHooks({ data: sampleData });
    vi.mocked(useInboxUpdates).mockReturnValue({ announce: 'Inbox updated' });
    renderPage();

    const region = screen.getByTestId('inbox-autorefresh-status');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveTextContent('Inbox updated');
    // It is a distinct node from the manual-refresh region (no OR-masking).
    expect(region).not.toBe(screen.getByTestId('inbox-refresh-status'));
  });

  it('renders ActivityRail when inbox.showActivityRail is on', () => {
    // #283 decoupled from AI: even with aiPreview off, the rail shows when its flag is on.
    mockViewportWide(true); // #300 rail also needs a wide viewport
    setHooks({ data: sampleData, aiPreview: false, showActivityRail: true });
    renderPage();
    expect(screen.getByRole('complementary', { name: /activity/i })).toBeInTheDocument();
  });

  it('hides ActivityRail below the 1180px breakpoint even when the toggle is on', () => {
    // #300 two-layout gate: rail visible iff toggle ON *and* viewport wide enough.
    mockViewportWide(false);
    setHooks({ data: sampleData, aiPreview: false, showActivityRail: true });
    renderPage();
    expect(screen.queryByRole('complementary', { name: /activity/i })).not.toBeInTheDocument();
  });

  it('hides ActivityRail when inbox.showActivityRail is off even with aiPreview on', () => {
    // #283 decoupled from AI: AI on must NOT surface the fabricated rail.
    setHooks({ data: sampleData, aiPreview: true, showActivityRail: false });
    renderPage();
    expect(screen.queryByRole('complementary', { name: /activity/i })).not.toBeInTheDocument();
  });

  it('renders InboxFooter when tokenScopeFooterEnabled is true', () => {
    setHooks({ data: sampleData });
    renderPage();
    expect(screen.getByText(/some prs may be hidden/i)).toBeInTheDocument();
  });

  it('omits InboxFooter when tokenScopeFooterEnabled is false', () => {
    setHooks({ data: { ...sampleData, tokenScopeFooterEnabled: false } });
    renderPage();
    expect(screen.queryByText(/some prs may be hidden/i)).not.toBeInTheDocument();
  });

  it('filtering to nothing shows the no-match zero-state, not EmptyAllSections', async () => {
    // sampleData has one PR with ci: 'none'. Filtering on CI failing matches
    // nothing, so the distinct zero-match state shows — NOT EmptyAllSections
    // (which is reserved for a genuinely empty inbox, gated on !filterActive).
    setHooks({ data: sampleData });
    renderPage();
    await screen.findByTestId('inbox-page');
    fireEvent.click(screen.getByRole('button', { name: /CI/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'failing' }));
    expect(screen.getByText(/No PRs match your filters/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in your inbox/)).toBeNull();
  });

  it('renders sections in the saved order with recently-closed pinned last', () => {
    setHooks({
      data: {
        sections: [
          { id: 'review-requested', label: 'Review requested', items: [] },
          { id: 'authored-by-me', label: 'Authored by me', items: [] },
          { id: 'mentioned', label: 'Mentioned', items: [] },
          { id: 'recently-closed', label: 'Recently closed', items: [] },
        ],
        enrichments: {},
        lastRefreshedAt: '',
        tokenScopeFooterEnabled: false,
        ciProbeComplete: true,
      },
      // awaiting-author is in the saved order but absent from `sections` — exercises
      // orderInboxSections' "saved id matching no live section is harmlessly ignored".
      sectionOrder: 'mentioned,authored-by-me,review-requested,awaiting-author',
    });
    render(
      <MemoryRouter>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    // InboxSection renders a <button> header whose textContent is: caret + label + count.
    // Filter to buttons that contain any of the four section label substrings.
    const order = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => /Review requested|Authored by me|Mentioned|Recently closed/.test(t));
    // Exactly the 4 live sections render; pin the count so "recently-closed last" is
    // an explicit guarantee, not an artifact of the filter happening to match 4.
    expect(order).toHaveLength(4);
    expect(order[0]).toMatch(/Mentioned/);
    expect(order[1]).toMatch(/Authored by me/);
    expect(order[2]).toMatch(/Review requested/);
    expect(order.at(-1)).toMatch(/Recently closed/);
  });
});

describe('InboxPage — useAiGate migrations', () => {
  beforeEach(() => {
    vi.mocked(useAiGate).mockReset();
    // Provide minimal mocks so the page can render
    vi.mocked(useInbox).mockReturnValue({
      data: {
        sections: [],
        enrichments: {},
        lastRefreshedAt: '2026-01-01T00:00:00Z',
        tokenScopeFooterEnabled: false,
        ciProbeComplete: true,
      } as InboxResponse,
      isLoading: false,
      error: null,
      reload: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(useInboxUpdates).mockReturnValue({ announce: '' });
    // These mocks are only needed if InboxPage still calls them directly.
    // After migration they become no-ops, but the vi.mock() hoisting keeps them registered.
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { inboxEnrichment: false } as AiCapabilities,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: {
          theme: 'system',
          accent: 'indigo',
          aiMode: 'off',
          density: 'comfortable',
          contentScale: 'm',
        },
        inbox: {
          sections: {
            'review-requested': true,
            'awaiting-author': true,
            'authored-by-me': true,
            mentioned: true,
            'recently-closed': true,
          },
          defaultSort: 'updated',
          sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
          showActivityRail: false,
          groupByRepo: true,
        },
        github: {
          host: 'https://github.com',
          configPath: '/fake/config.json',
          logsPath: '/fake/logs',
        },
      } as PreferencesResponse,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    });
  });

  // #283: re-point usePreferences with a chosen showActivityRail; AI preview stays whatever
  // the beforeEach set (off) to prove the rail does not ride the AI gate.
  function setShowActivityRail(showActivityRail: boolean) {
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: {
          theme: 'system',
          accent: 'indigo',
          aiMode: 'off',
          density: 'comfortable',
          contentScale: 'm',
        },
        inbox: {
          sections: {
            'review-requested': true,
            'awaiting-author': true,
            'authored-by-me': true,
            mentioned: true,
            'recently-closed': true,
          },
          defaultSort: 'updated',
          sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
          showActivityRail,
          groupByRepo: true,
        },
        github: {
          host: 'https://github.com',
          configPath: '/fake/config.json',
          logsPath: '/fake/logs',
        },
      } as PreferencesResponse,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('uses useAiGate for the category chip but NOT for the activity rail (#283 decouple)', () => {
    vi.mocked(useAiGate).mockReturnValue(false);
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    const calls = vi.mocked(useAiGate).mock.calls.map((c) => c[0]);
    expect(calls).toContain('inboxEnrichment');
    expect(calls).not.toContain('inboxRanking'); // rail no longer rides the AI gate
  });

  it('hides the activity rail when inbox.showActivityRail is false', () => {
    vi.mocked(useAiGate).mockReturnValue(false);
    setShowActivityRail(false);
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="activity-rail"]')).toBeNull();
  });

  it('shows the activity rail when inbox.showActivityRail is true (AI gate off)', () => {
    mockViewportWide(true); // #300 rail also needs a wide viewport
    vi.mocked(useAiGate).mockReturnValue(false); // AI fully off — rail still shows
    setShowActivityRail(true);
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="activity-rail"]')).not.toBeNull();
  });
});

// ── #485 onboarding overlay gate ──────────────────────────────────────────────
// AiOnboardingDialog is stubbed (see top-level vi.mock) to a sentinel testid so
// these tests assert MOUNTING logic in InboxPage, not the dialog's internals.

describe('InboxPage — onboarding overlay gate (#485)', () => {
  // Shared mutable prefs state — tests mutate before rendering.
  const prefs = {
    onboardingSeen: false as boolean,
    value: 'present' as 'present' | null, // 'null' → usePreferences returns preferences:null
  };

  function buildPreferences(onboardingSeen: boolean): PreferencesResponse {
    return {
      ui: {
        theme: 'system',
        accent: 'indigo',
        aiMode: 'off',
        density: 'comfortable',
        contentScale: 'm',
        providerTimeoutSeconds: 30,
        hunkAnnotationCap: 10,
        summaryMaxChars: 1000,
        onboardingSeen,
      },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'recently-closed': true,
        },
        defaultSort: 'updated',
        sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
        showActivityRail: false,
        groupByRepo: true,
      },
      github: {
        host: 'https://github.com',
        configPath: '/fake/config.json',
        logsPath: '/fake/logs',
      },
    } as PreferencesResponse;
  }

  function applyPrefs() {
    vi.mocked(usePreferences).mockReturnValue({
      preferences: prefs.value === null ? null : buildPreferences(prefs.onboardingSeen),
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prefs.onboardingSeen = false;
    prefs.value = 'present';

    // Provide a loaded inbox so we never hit the loading/error early-returns
    // (the overlay must render over loading too, but we test that separately).
    vi.mocked(useInbox).mockReturnValue({
      data: {
        sections: [],
        enrichments: {},
        lastRefreshedAt: new Date().toISOString(),
        tokenScopeFooterEnabled: false,
        ciProbeComplete: true,
      } as InboxResponse,
      isLoading: false,
      error: null,
      reload: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(useInboxUpdates).mockReturnValue({ announce: '' });
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { inboxEnrichment: false } as AiCapabilities,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(useAiGate).mockReturnValue(false);
    applyPrefs();
  });

  it('mounts the onboarding overlay when onboardingSeen is false', () => {
    prefs.onboardingSeen = false;
    applyPrefs();
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('onboarding-dialog')).toBeInTheDocument();
  });

  it('does NOT mount the overlay when onboardingSeen is true', () => {
    prefs.onboardingSeen = true;
    applyPrefs();
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
  });

  it('does NOT mount the overlay until preferences resolve (preferences null)', () => {
    prefs.value = null;
    applyPrefs();
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
  });

  it('auto-dismisses when onboardingSeen flips to true externally (multi-window)', () => {
    prefs.onboardingSeen = false;
    applyPrefs();
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('onboarding-dialog')).toBeInTheDocument();

    // Simulate a focus-refetch in another window resolving onboardingSeen=true.
    prefs.onboardingSeen = true;
    applyPrefs();
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
  });

  it('also mounts the overlay over the loading skeleton (not just the loaded inbox)', () => {
    prefs.onboardingSeen = false;
    applyPrefs();
    // Override: no data yet, actively loading
    vi.mocked(useInbox).mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      reload: vi.fn().mockResolvedValue(undefined),
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-dialog')).toBeInTheDocument();
  });

  it('does NOT mount the overlay over the error modal', () => {
    prefs.onboardingSeen = false;
    applyPrefs();
    vi.mocked(useInbox).mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('boom'),
      reload: vi.fn().mockResolvedValue(undefined),
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/couldn.t load inbox/i)).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
  });
});
