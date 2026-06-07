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
  mergedAt: null,
  closedAt: null,
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
};

function TabsProbe() {
  const { openTabs } = useOpenTabs();
  return <div data-testid="tab-count">{openTabs.length}</div>;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

function renderInboxRow(pr: PrInboxItem = PR, props: Partial<Parameters<typeof InboxRow>[0]> = {}) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxRow pr={pr} showCategoryChip={false} maxDiff={100} {...props} />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
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

describe('InboxRow avatar', () => {
  it('renders the author avatar next to the author name', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <InboxRow pr={PR} enrichment={undefined} showCategoryChip={false} maxDiff={100} />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    const author = screen.getByText(PR.author);
    const group = author.closest('[data-testid="inbox-author"]');
    expect(group).not.toBeNull();
    expect(group!.querySelector('[data-testid="avatar"]')).not.toBeNull();
  });
});

describe('InboxRow title', () => {
  it('exposes the full title via the title attribute and aria-label so a clamped title is recoverable', () => {
    const long = { ...PR, title: 'Refactor the pagination cursor encoder to be stable across reorders and deletes' };
    const { container } = renderInboxRow(long);
    const titleEl = container.querySelector('[class*="title"]')!;
    expect(titleEl.getAttribute('title')).toBe(long.title);
    // truncation hides nothing from AT: the untruncated title stays in the aria-label
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain(long.title);
  });
});

describe('InboxRow meta', () => {
  it('wraps the author name in a dedicated truncating span so the meta line stays single-line', () => {
    renderInboxRow(PR);
    const name = screen.getByText(PR.author);
    expect(name.className).toMatch(/authorName/);
  });
});

describe('InboxRow showRepo', () => {
  function renderRow(showRepo?: boolean) {
    return render(
      <MemoryRouter>
        <OpenTabsProvider>
          <InboxRow pr={PR} showCategoryChip={false} maxDiff={100} showRepo={showRepo} />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
  }

  it('shows the repo by default', () => {
    renderRow();
    expect(screen.getByText('acme/api')).toBeInTheDocument();
  });

  it('hides the repo and its separator when showRepo=false', () => {
    const { container } = renderRow(false);
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
    const meta = container.querySelector('[class*="meta"]')!;
    expect(meta.textContent!.trimStart().startsWith('·')).toBe(false);
  });
});
