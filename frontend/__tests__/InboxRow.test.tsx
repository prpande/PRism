import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { InboxRow } from '../src/components/Inbox/InboxRow';
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
};

function renderRow(
  pr: PrInboxItem,
  opts: { showCategoryChip?: boolean; enrichment?: InboxItemEnrichment } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
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

  it('shows New chip when lastViewedHeadSha is null', () => {
    renderRow(basePr);
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('shows CI failing dot when ci is failing', () => {
    renderRow({ ...basePr, ci: 'failing', lastViewedHeadSha: 'old-sha' });
    expect(screen.getByTitle('CI failing')).toBeInTheDocument();
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
});
