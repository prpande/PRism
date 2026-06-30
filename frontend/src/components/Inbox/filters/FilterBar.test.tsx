import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FilterBar } from './FilterBar';
import { OpenTabsProvider } from '../../../contexts/OpenTabsContext';
import type { InboxSection, PrInboxItem } from '../../../api/types';

// FilterBar reads useAuth to suppress the centered "Updated <age>" pill while the
// GitHub credential is invalid (the re-auth banner owns the toolbar center then).
// Mock it (vi.hoisted mutable state, repo pattern: GitHubAuthBanner.test.tsx) so the
// bar renders without an AuthProvider; default to a healthy/valid credential.
const { authState } = vi.hoisted(() => ({
  authState: { hasToken: true, githubCredentialInvalid: false },
}));
vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ authState, error: null, refetch: vi.fn() }),
}));

beforeEach(() => {
  authState.hasToken = true;
  authState.githubCredentialInvalid = false;
});

// Complete fixtures (see Task 12 note): the bar runs applyInboxFilters which sorts
// unconditionally, so items need updatedAt/reference or the comparator throws.
const item = (ci: PrInboxItem['ci'], n: number): PrInboxItem => ({
  reference: { owner: 'acme', repo: 'api', number: n },
  title: 't',
  author: 'dana',
  repo: 'acme/api',
  updatedAt: '2026-06-01T00:00:00Z',
  pushedAt: '2026-06-01T00:00:00Z',
  commitCount: 1,
  changedFiles: 0,
  commentCount: 0,
  additions: 0,
  deletions: 0,
  headSha: 's',
  ci,
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
  isDraft: false,
});
const secs: InboxSection[] = [
  { id: 's', label: 's', items: [item('failing', 1), item('none', 2)] },
];

const onState = vi.fn();

it('CI trigger shows the failing count when unselected', () => {
  // FilterBar now nests InboxQueryInput, which uses useNavigate + useOpenTabs —
  // so the bar must render inside a Router + OpenTabsProvider.
  render(
    <MemoryRouter>
      <OpenTabsProvider>
        <FilterBar
          sections={secs}
          initialSort="updated"
          ciProbeComplete
          onState={onState}
          refresh={vi.fn()}
          isRefreshing={false}
          justRefreshed={false}
          lastRefreshedAt={new Date().toISOString()}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: /CI/ })).toHaveTextContent('CI · 1');
});

it('sort control is an accessible combobox named "Sort" with no visible "Sort:" text', () => {
  render(
    <MemoryRouter>
      <OpenTabsProvider>
        <FilterBar
          sections={secs}
          initialSort="updated"
          ciProbeComplete
          onState={onState}
          refresh={vi.fn()}
          isRefreshing={false}
          justRefreshed={false}
          lastRefreshedAt={new Date().toISOString()}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  // #300 — the visible "Sort:" label is dropped; the select keeps an accessible name.
  expect(screen.getByRole('combobox', { name: /^sort$/i })).toBeInTheDocument();
  expect(screen.queryByText('Sort:')).not.toBeInTheDocument();
});

it('selecting a sort option updates the control via the themed Select', async () => {
  render(
    <MemoryRouter>
      <OpenTabsProvider>
        <FilterBar
          sections={secs}
          initialSort="updated"
          ciProbeComplete
          onState={onState}
          refresh={vi.fn()}
          isRefreshing={false}
          justRefreshed={false}
          lastRefreshedAt={new Date().toISOString()}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('combobox', { name: /^sort$/i }));
  await userEvent.click(screen.getByRole('option', { name: 'Most comments' }));
  expect(screen.getByRole('combobox', { name: /^sort$/i })).toHaveTextContent('Most comments');
});

// #619 — the "Updated <age>" pill must not collide with the centered re-auth banner.
const renderBar = (lastRefreshedAt: string) =>
  render(
    <MemoryRouter>
      <OpenTabsProvider>
        <FilterBar
          sections={secs}
          initialSort="updated"
          ciProbeComplete
          onState={onState}
          refresh={vi.fn()}
          isRefreshing={false}
          justRefreshed={false}
          lastRefreshedAt={lastRefreshedAt}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );

it('shows the stale pill for an old refresh when the credential is valid', () => {
  renderBar(new Date(0).toISOString()); // 1970 → far past the 30-min threshold
  expect(screen.getByTestId('inbox-stale-pill')).toBeInTheDocument();
});

it('suppresses the stale pill when the GitHub credential is invalid (re-auth banner owns the center)', () => {
  authState.githubCredentialInvalid = true;
  renderBar(new Date(0).toISOString()); // same old timestamp; pill would otherwise show
  expect(screen.queryByTestId('inbox-stale-pill')).not.toBeInTheDocument();
});
