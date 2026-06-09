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
    const long = {
      ...PR,
      title: 'Refactor the pagination cursor encoder to be stable across reorders and deletes',
    };
    const { container } = renderInboxRow(long);
    const titleEl = container.querySelector('[class*="title"][title]')!;
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

describe('InboxRow PR-state leading icon', () => {
  it('renders the open glyph for an open PR', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: null, closedAt: null });
    expect(container.querySelector('[data-pr-state="open"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· open');
  });

  it('renders the merged glyph + aria for a merged PR', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });

  it('renders the closed glyph + aria for a closed PR', () => {
    const { container } = renderInboxRow({ ...PR, closedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="closed"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· closed');
  });

  it('no longer renders a "Merged"/"Closed" text badge', () => {
    renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(screen.queryByText('Merged')).toBeNull();
  });
});

describe('InboxRow CI suffix glyph', () => {
  it('renders a passing check glyph + aria for an open passing PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'passing' });
    expect(container.querySelector('[data-ci="passing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI passing');
  });

  it('renders a failing cross glyph + aria for an open failing PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing' });
    expect(container.querySelector('[data-ci="failing"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI failing');
  });

  it('renders a pending dot glyph + aria for an open pending PR', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'pending' });
    expect(container.querySelector('[data-ci="pending"]')).not.toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('CI pending');
  });

  it('renders no CI glyph and no CI suffix when ci is none', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'none' });
    expect(container.querySelector('[data-ci]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
  });

  it('renders no CI glyph on a done (merged) PR even when ci=failing', () => {
    const { container } = renderInboxRow({
      ...PR,
      ci: 'failing',
      mergedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-ci]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('CI ');
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

describe('InboxRow grouped indent', () => {
  it('marks grouped rows with data-grouped=true', () => {
    renderInboxRow(PR, { grouped: true });
    expect(screen.getByRole('button').getAttribute('data-grouped')).toBe('true');
  });

  it('flat rows are data-grouped=false', () => {
    renderInboxRow(PR);
    expect(screen.getByRole('button').getAttribute('data-grouped')).toBe('false');
  });
});

describe('InboxRow tail reserve-and-collapse', () => {
  it('always reserves the diff, counts, and comment slots', () => {
    const { container } = renderInboxRow({ ...PR, additions: 0, deletions: 0, commentCount: 0 });
    expect(container.querySelector('[class*="diffSlot"]')).not.toBeNull();
    expect(container.querySelector('[class*="countsSlot"]')).not.toBeNull();
    expect(container.querySelector('[class*="commentSlot"]')).not.toBeNull();
  });

  it('renders the diff-bar slot empty at zero diff but keeps the counts populated', () => {
    const { container } = renderInboxRow({ ...PR, additions: 0, deletions: 0 });
    const diffSlot = container.querySelector('[class*="diffSlot"]')!;
    expect(diffSlot.querySelector('[class*="diffbar"]')).toBeNull(); // DiffBar returns null at zero total
    expect(container.querySelector('[class*="countsSlot"]')!.textContent).toContain('+0');
  });

  it('renders the comment slot empty when commentCount is 0', () => {
    const { container } = renderInboxRow({ ...PR, commentCount: 0 });
    expect(
      container.querySelector('[class*="commentSlot"]')!.querySelector('[class*="comments"]'),
    ).toBeNull();
  });

  it('renders the comment count with an accent comment glyph when commentCount > 0', () => {
    const { container } = renderInboxRow({ ...PR, commentCount: 5 });
    const slot = container.querySelector('[class*="commentSlot"]')!;
    expect(slot.textContent).toContain('5');
    // an SVG glyph (not an emoji) labels the number as a comment count
    expect(slot.querySelector('svg')).not.toBeNull();
  });

  it('renders a 3-digit comment count intact (the adversarial-finding case the 52px slot widening fixed)', () => {
    // commentSlot was widened 44px → 52px so a 3-digit pill no longer overflows.
    // The slot width is CSS (not unit-testable in jsdom), but assert the full
    // count text renders without truncation so the regression stays closed.
    const { container } = renderInboxRow({ ...PR, commentCount: 123 });
    const slot = container.querySelector('[class*="commentSlot"]')!;
    expect(slot.textContent).toContain('123');
    expect(slot.querySelector('svg')).not.toBeNull();
  });
});

describe('InboxRow chip + badge placement (on the meta line, not the metrics tail)', () => {
  it('renders the AI category chip on the meta line, not inside the metrics tail', () => {
    renderInboxRow(PR, {
      showCategoryChip: true,
      enrichment: { prId: 'x', categoryChip: 'Refactor', hoverSummary: null },
    });
    const chip = screen.getByText('Refactor');
    // chip lives in the elastic meta line so it's always visible, and is NOT in
    // the fixed-width metrics tail (where it would be clipped — see #227 B1)
    expect(chip.closest('[class*="meta"]')).not.toBeNull();
    expect(chip.closest('[class*="tail"]')).toBeNull();
  });

  it('shows merged state via the leading icon + aria, not a meta-line badge', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.queryByText('Merged')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });
});
