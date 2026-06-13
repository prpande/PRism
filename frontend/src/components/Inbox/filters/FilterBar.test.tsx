import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FilterBar } from './FilterBar';
import { OpenTabsProvider } from '../../../contexts/OpenTabsContext';
import type { InboxSection, PrInboxItem } from '../../../api/types';

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
  commentCount: 0,
  additions: 0,
  deletions: 0,
  headSha: 's',
  ci,
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
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
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  // #300 — the visible "Sort:" label is dropped; the select keeps an accessible name.
  expect(screen.getByRole('combobox', { name: /^sort$/i })).toBeInTheDocument();
  expect(screen.queryByText('Sort:')).not.toBeInTheDocument();
});
