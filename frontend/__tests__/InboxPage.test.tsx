import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboxResponse, AiCapabilities, PreferencesResponse } from '../src/api/types';
import { InboxPage } from '../src/pages/InboxPage';
import { OpenTabsProvider } from '../src/contexts/OpenTabsContext';

vi.mock('../src/hooks/useInbox', () => ({
  useInbox: vi.fn(),
}));
vi.mock('../src/hooks/useInboxUpdates', () => ({
  useInboxUpdates: vi.fn(),
}));
vi.mock('../src/hooks/useCapabilities', () => ({
  useCapabilities: vi.fn(),
}));
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: vi.fn(),
}));
vi.mock('../src/hooks/useAiGate', () => ({
  useAiGate: vi.fn(),
}));

import { useInbox } from '../src/hooks/useInbox';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';
import { useCapabilities } from '../src/hooks/useCapabilities';
import { usePreferences } from '../src/hooks/usePreferences';
import { useAiGate } from '../src/hooks/useAiGate';

function setHooks(
  opts: {
    data?: InboxResponse | null;
    isLoading?: boolean;
    error?: unknown;
    hasUpdate?: boolean;
    // aiPreview now controls the inboxRanking gate (ActivityRail visibility)
    aiPreview?: boolean;
    inboxEnrichment?: boolean;
    sectionOrder?: string;
  } = {},
) {
  vi.mocked(useInbox).mockReturnValue({
    data: opts.data ?? null,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
    reload: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(useInboxUpdates).mockReturnValue({
    hasUpdate: opts.hasUpdate ?? false,
    summary: opts.hasUpdate ? '3 new updates' : '',
    dismiss: vi.fn(),
  });
  // InboxPage now uses useAiGate for both gates.
  // useCapabilities / usePreferences are no longer called directly by InboxPage
  // but are kept to satisfy the transitive mock chain (useAiGate internally calls
  // both; its mock here short-circuits that, but the registrations prevent
  // "unmocked module" warnings from other test paths).
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
        aiPreview: opts.aiPreview ?? false,
      },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'recently-closed': true,
        },
        sectionOrder:
          opts.sectionOrder ?? 'review-requested,awaiting-author,authored-by-me,mentioned',
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
  // Wire useAiGate: inboxEnrichment → showCategoryChip, inboxRanking → showActivityRail.
  // aiPreview maps to inboxRanking because showActivityRail was previously gated on
  // preferences.ui.aiPreview (see migration note in InboxPage.tsx).
  vi.mocked(useAiGate).mockImplementation((key) => {
    if (key === 'inboxEnrichment') return opts.inboxEnrichment ?? false;
    if (key === 'inboxRanking') return opts.aiPreview ?? false;
    return false;
  });
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

  it('renders banner when updates are pending', () => {
    setHooks({ data: sampleData, hasUpdate: true });
    renderPage();
    expect(screen.getByText(/3 new updates/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('renders ActivityRail when aiPreview is on', () => {
    setHooks({ data: sampleData, aiPreview: true });
    renderPage();
    expect(screen.getByRole('complementary', { name: /activity/i })).toBeInTheDocument();
  });

  it('hides ActivityRail when aiPreview is off', () => {
    setHooks({ data: sampleData, aiPreview: false });
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
    vi.mocked(useInboxUpdates).mockReturnValue({
      hasUpdate: false,
      summary: '',
      dismiss: vi.fn(),
    });
    // These mocks are only needed if InboxPage still calls them directly.
    // After migration they become no-ops, but the vi.mock() hoisting keeps them registered.
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: { inboxEnrichment: false } as AiCapabilities,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
        inbox: {
          sections: {
            'review-requested': true,
            'awaiting-author': true,
            'authored-by-me': true,
            mentioned: true,
            'recently-closed': true,
          },
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

  it('calls useAiGate("inboxEnrichment") and useAiGate("inboxRanking")', () => {
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
    expect(calls).toContain('inboxRanking');
  });

  it('hides the activity rail when inboxRanking gate is off', () => {
    vi.mocked(useAiGate).mockImplementation((key) => key === 'inboxEnrichment');
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxPage />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="activity-rail"]')).toBeNull();
  });

  it('shows the activity rail when inboxRanking gate is on', () => {
    vi.mocked(useAiGate).mockImplementation((key) => key === 'inboxRanking');
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
