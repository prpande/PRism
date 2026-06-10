import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { InboxRow } from '../src/components/Inbox/InboxRow';
import { OpenTabsProvider } from '../src/contexts/OpenTabsContext';
import type { PrInboxItem, InboxItemEnrichment } from '../src/api/types';

const basePr: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 42 },
  title: 'Refactor auth flow',
  author: 'amelia',
  repo: 'acme/api',
  updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(),
  iterationNumber: 3,
  commentCount: 7,
  additions: 50,
  deletions: 10,
  headSha: 'abc',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
};

function renderRow(
  pr: PrInboxItem,
  opts: { showCategoryChip?: boolean; enrichment?: InboxItemEnrichment } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <OpenTabsProvider>
        <Routes>
          <Route
            path="/"
            element={
              <InboxRow
                pr={pr}
                enrichment={opts.enrichment}
                showCategoryChip={opts.showCategoryChip ?? false}
                maxDiff={100}
              />
            }
          />
          <Route
            path="/pr/:owner/:repo/:number"
            element={<div data-testid="pr-detail">PR detail</div>}
          />
        </Routes>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('InboxRow', () => {
  it('renders title, repo, author, age', () => {
    renderRow(basePr);
    expect(screen.getByText('Refactor auth flow')).toBeInTheDocument();
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByText('amelia')).toBeInTheDocument();
  });

  // #121/#122: the "New" badge is gone; the left accent bar (data-unread) is the
  // single new-activity indicator, driven by "commits since you last viewed",
  // not 30-min recency.
  it('no longer renders the "New" badge', () => {
    renderRow(basePr);
    expect(screen.queryByText('New')).toBeNull();
  });

  it('marks unread when the head moved since last view', () => {
    renderRow({ ...basePr, lastViewedHeadSha: 'old', headSha: 'new' });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(row.getAttribute('aria-label')).toContain('unread');
  });

  it('is NOT unread when viewed head matches current head', () => {
    renderRow({ ...basePr, lastViewedHeadSha: 'same', headSha: 'same' });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'false');
    expect(row.getAttribute('aria-label')).not.toContain('unread');
  });

  it('IS unread for a never-opened PR (lastViewedHeadSha null) — its current state is unseen', () => {
    renderRow({ ...basePr, lastViewedHeadSha: null, headSha: 'abc' });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(row.getAttribute('aria-label')).toContain('unread');
  });

  it('is NOT unread for a merged PR even if the head moved', () => {
    renderRow({
      ...basePr,
      lastViewedHeadSha: 'old',
      headSha: 'new',
      mergedAt: new Date().toISOString(),
    });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'false');
    expect(row.getAttribute('aria-label')).not.toContain('unread');
  });

  it('is NOT unread for a closed PR even if the head moved', () => {
    renderRow({
      ...basePr,
      lastViewedHeadSha: 'old',
      headSha: 'new',
      closedAt: new Date().toISOString(),
    });
    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'false');
  });

  it('renders the CI failing glyph when ci is failing', () => {
    const { container } = renderRow({ ...basePr, ci: 'failing', lastViewedHeadSha: 'old-sha' });
    expect(container.querySelector('[data-ci="failing"]')).not.toBeNull();
  });

  it('does not render category chip when showCategoryChip is false', () => {
    const enrichment: InboxItemEnrichment = {
      prId: 'acme/api#42',
      categoryChip: 'Refactor',
      hoverSummary: null,
    };
    renderRow(basePr, { showCategoryChip: false, enrichment });
    expect(screen.queryByText('Refactor')).not.toBeInTheDocument();
  });

  it('renders category chip when showCategoryChip is true and enrichment exists', () => {
    const enrichment: InboxItemEnrichment = {
      prId: 'acme/api#42',
      categoryChip: 'Refactor',
      hoverSummary: null,
    };
    renderRow(basePr, { showCategoryChip: true, enrichment });
    expect(screen.getByText('Refactor')).toBeInTheDocument();
  });

  it('navigates to /pr/:owner/:repo/:number on click', async () => {
    renderRow(basePr);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refactor auth flow/i }));
    expect(await screen.findByTestId('pr-detail')).toBeInTheDocument();
  });

  it('renders friendly age text for very recent PRs', () => {
    renderRow({ ...basePr, updatedAt: new Date().toISOString() });
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it('shows merged state via the leading icon + aria (no text badge)', () => {
    const { container } = renderRow({ ...basePr, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.queryByText('Merged')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });

  it('shows closed state via the leading icon + aria (no text badge)', () => {
    const { container } = renderRow({
      ...basePr,
      mergedAt: null,
      closedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-pr-state="closed"]')).not.toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· closed');
  });

  it('does not show the New chip on a done row even when lastViewedHeadSha is null', () => {
    renderRow({ ...basePr, lastViewedHeadSha: null, mergedAt: new Date().toISOString() });
    expect(screen.queryByText('New')).not.toBeInTheDocument();
    // ...and the unread bar is suppressed too (done rows never flag).
    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'false');
  });

  it('renders no CI glyph on a done row', () => {
    const { container } = renderRow({
      ...basePr,
      ci: 'failing',
      mergedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-ci]')).toBeNull();
  });
});
