import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboxResponse, AiCapabilities, UiPreferences } from '../src/api/types';
import { InboxPage } from '../src/pages/InboxPage';

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

import { useInbox } from '../src/hooks/useInbox';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';
import { useCapabilities } from '../src/hooks/useCapabilities';
import { usePreferences } from '../src/hooks/usePreferences';

function setHooks(
  opts: {
    data?: InboxResponse | null;
    isLoading?: boolean;
    error?: unknown;
    hasUpdate?: boolean;
    aiPreview?: boolean;
    inboxEnrichment?: boolean;
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
  vi.mocked(useCapabilities).mockReturnValue({
    capabilities: {
      inboxEnrichment: opts.inboxEnrichment ?? false,
    } as AiCapabilities,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(usePreferences).mockReturnValue({
    preferences: {
      theme: 'system',
      accent: 'indigo',
      aiPreview: opts.aiPreview ?? false,
    } as UiPreferences,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
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
        },
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: new Date().toISOString(),
  tokenScopeFooterEnabled: true,
};

const emptyData: InboxResponse = {
  ...sampleData,
  sections: [{ id: 'review-requested', label: 'Review requested', items: [] }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <InboxPage />
    </MemoryRouter>,
  );
}

describe('InboxPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows loading state while fetching first snapshot', () => {
    setHooks({ data: null, isLoading: true });
    renderPage();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
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
});
