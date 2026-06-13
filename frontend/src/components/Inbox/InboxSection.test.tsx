import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { InboxSection } from './InboxSection';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import type { InboxSection as InboxSectionDto, PrInboxItem } from '../../api/types';

const examplePr: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 42 },
  title: 'Refactor auth flow',
  author: 'amelia',
  repo: 'acme/api',
  updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(),
  commitCount: 1,
  commentCount: 0,
  additions: 5,
  deletions: 2,
  headSha: 'abc',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
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

function renderSection(section: InboxSectionDto, opts: { defaultOpen?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxSection
          section={section}
          enrichments={{}}
          showCategoryChip={false}
          maxDiff={10}
          defaultOpen={opts.defaultOpen}
        />
      </OpenTabsProvider>
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
    expect(screen.getByText('Nothing needs re-review.')).toBeInTheDocument();
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

  it('is collapsed when defaultOpen is false', () => {
    const closedSection: InboxSectionDto = {
      id: 'recently-closed',
      label: 'Recently closed',
      items: [examplePr],
    };
    renderSection(closedSection, { defaultOpen: false });
    expect(screen.queryByText('Refactor auth flow')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /recently closed/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('is expanded by default when defaultOpen is omitted', () => {
    renderSection(populatedSection);
    expect(screen.getByText('Refactor auth flow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review requested/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows the recently-closed caption unconditionally for any non-empty recently-closed section', () => {
    const items: PrInboxItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...examplePr,
      reference: { owner: 'acme', repo: 'api', number: 100 + i },
      title: `Closed PR ${i}`,
    }));
    const section: InboxSectionDto = {
      id: 'recently-closed',
      label: 'Recently closed',
      items,
    };
    renderSection(section);
    expect(screen.getByText(/most recent first/i)).toBeInTheDocument();
  });

  it('shows the recently-closed caption even when fewer than 30 items', () => {
    const items: PrInboxItem[] = Array.from({ length: 5 }, (_, i) => ({
      ...examplePr,
      reference: { owner: 'acme', repo: 'api', number: 100 + i },
      title: `Closed PR ${i}`,
    }));
    const section: InboxSectionDto = {
      id: 'recently-closed',
      label: 'Recently closed',
      items,
    };
    renderSection(section);
    expect(screen.getByText(/most recent first/i)).toBeInTheDocument();
  });

  it('does not show the truncation hint for a non-recently-closed section with 30 items', () => {
    const items: PrInboxItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...examplePr,
      reference: { owner: 'acme', repo: 'api', number: 100 + i },
      title: `Open PR ${i}`,
    }));
    const section: InboxSectionDto = {
      id: 'review-requested',
      label: 'Review requested',
      items,
    };
    renderSection(section);
    expect(screen.queryByText(/most recent/)).toBeNull();
  });
});
