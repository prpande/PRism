import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { InboxSection } from './InboxSection';
import type { PrInboxItem, InboxSection as InboxSectionDto } from '../../api/types';

function prFor(owner: string, repo: string, n: number): PrInboxItem {
  return {
    reference: { owner, repo, number: n },
    title: `PR ${n}`,
    author: 'a',
    repo: `${owner}/${repo}`,
    updatedAt: '2026-05-01T00:00:00Z',
    pushedAt: '2026-05-01T00:00:00Z',
    iterationNumber: 1,
    commentCount: 0,
    additions: 0,
    deletions: 0,
    headSha: 'x',
    ci: 'none',
    lastViewedHeadSha: null,
    lastSeenCommentId: null,
    mergedAt: null,
    closedAt: null,
  };
}
function makeSection(id: string, items: PrInboxItem[]): InboxSectionDto {
  return { id, label: id, items };
}
function renderSection(section: InboxSectionDto, props?: { defaultOpen?: boolean }) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxSection
          section={section}
          enrichments={{}}
          showCategoryChip={false}
          maxDiff={100}
          defaultOpen={props?.defaultOpen ?? true}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('InboxSection grouping', () => {
  it('renders a RepoGroupAccordion per repo for a multi-repo section (repos open by default)', () => {
    renderSection(
      makeSection('review-requested', [prFor('acme', 'api', 1), prFor('acme', 'web', 2)]),
    );
    expect(screen.getByRole('button', { name: /acme\/api, 1 pull request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /acme\/web, 1 pull request/i })).toBeInTheDocument();
    expect(screen.getByText('PR 1')).toBeInTheDocument();
  });

  it('renders flat rows (no accordion) for a single-repo section', () => {
    renderSection(
      makeSection('review-requested', [prFor('acme', 'api', 1), prFor('acme', 'api', 2)]),
    );
    expect(screen.queryByRole('button', { name: /pull requests?/i })).not.toBeInTheDocument();
    expect(screen.getByText('PR 1')).toBeInTheDocument();
    expect(screen.getAllByText('acme/api').length).toBeGreaterThan(0);
  });

  it('recently-closed repo groups start collapsed and the caption renders', () => {
    renderSection(
      makeSection('recently-closed', [prFor('acme', 'api', 1), prFor('acme', 'web', 2)]),
      { defaultOpen: true },
    );
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    expect(screen.getByText(/most recent first/i)).toBeInTheDocument();
  });
});
