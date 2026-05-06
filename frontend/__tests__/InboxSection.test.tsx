import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { InboxSection } from '../src/components/Inbox/InboxSection';
import type { InboxSection as InboxSectionDto, PrInboxItem } from '../src/api/types';

const examplePr: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 42 },
  title: 'Refactor auth flow',
  author: 'amelia',
  repo: 'acme/api',
  updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(),
  iterationNumber: 1,
  commentCount: 0,
  additions: 5,
  deletions: 2,
  headSha: 'abc',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
};

const emptySection: InboxSectionDto = {
  id: 'awaiting-author',
  label: 'Awaiting author',
  items: [],
};
const populatedSection: InboxSectionDto = {
  id: 'review-requested',
  label: 'Review requested',
  items: [examplePr],
};

function renderSection(section: InboxSectionDto) {
  return render(
    <MemoryRouter>
      <InboxSection section={section} enrichments={{}} showCategoryChip={false} maxDiff={10} />
    </MemoryRouter>,
  );
}

describe('InboxSection', () => {
  it('renders label and item count', () => {
    renderSection(populatedSection);
    expect(screen.getByText('Review requested')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders section-specific empty copy by id', () => {
    renderSection(emptySection);
    expect(screen.getByText('Nothing waiting on the author.')).toBeInTheDocument();
  });

  it('falls back to generic empty copy for unknown section ids', () => {
    renderSection({ id: 'unknown-section', label: 'Unknown', items: [] });
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('toggles open/closed on header click', async () => {
    renderSection(populatedSection);
    const user = userEvent.setup();
    expect(screen.getByText('Refactor auth flow')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /review requested/i }));
    expect(screen.queryByText('Refactor auth flow')).not.toBeInTheDocument();
  });

  it('renders rows when items exist', () => {
    renderSection(populatedSection);
    expect(screen.getByText('Refactor auth flow')).toBeInTheDocument();
  });
});
