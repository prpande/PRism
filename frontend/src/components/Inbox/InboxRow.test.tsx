import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { InboxRow } from './InboxRow';
import type { PrInboxItem } from '../../api/types';

const PR: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 99 },
  title: 'Add user pagination',
  author: 'alice',
  repo: 'acme/api',
  updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(),
  iterationNumber: 2,
  commentCount: 3,
  additions: 50,
  deletions: 10,
  headSha: 'abc',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
};

function TabsProbe() {
  const { openTabs } = useOpenTabs();
  return <div data-testid="tab-count">{openTabs.length}</div>;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

describe('InboxRow click → opens tab', () => {
  it('adds the PR to openTabs and navigates to /pr/owner/repo/number', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <TabsProbe />
          <LocationProbe />
          <Routes>
            <Route
              path="/"
              element={
                <InboxRow pr={PR} enrichment={undefined} showCategoryChip={false} maxDiff={100} />
              }
            />
            <Route path="/pr/:owner/:repo/:number" element={<div>PR Detail</div>} />
          </Routes>
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('tab-count').textContent).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: /Add user pagination/i }));
    expect(screen.getByTestId('tab-count').textContent).toBe('1');
    expect(screen.getByTestId('path').textContent).toBe('/pr/acme/api/99');
  });
});
