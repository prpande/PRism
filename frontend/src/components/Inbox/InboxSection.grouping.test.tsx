import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
function renderSection(
  section: InboxSectionDto,
  props?: { defaultOpen?: boolean; groupByRepo?: boolean },
) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxSection
          section={section}
          enrichments={{}}
          showCategoryChip={false}
          maxDiff={100}
          defaultOpen={props?.defaultOpen ?? true}
          groupByRepo={props?.groupByRepo}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

function renderForceOpen(
  section: InboxSectionDto,
  props: { defaultOpen?: boolean; forceOpen?: boolean },
) {
  const tree = (p: { defaultOpen?: boolean; forceOpen?: boolean }) => (
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxSection
          section={section}
          enrichments={{}}
          showCategoryChip={false}
          maxDiff={100}
          defaultOpen={p.defaultOpen ?? true}
          forceOpen={p.forceOpen}
        />
      </OpenTabsProvider>
    </MemoryRouter>
  );
  const { rerender } = render(tree(props));
  return {
    rerender: (p: { defaultOpen?: boolean; forceOpen?: boolean }) => rerender(tree(p)),
  };
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

  it('renders flat rows (no accordion) for a multi-repo section when groupByRepo is off (#219)', () => {
    renderSection(
      makeSection('review-requested', [prFor('acme', 'api', 1), prFor('acme', 'web', 2)]),
      { groupByRepo: false },
    );
    // No repo accordions — every PR is a flat InboxRow.
    expect(screen.queryByRole('button', { name: /pull requests?/i })).not.toBeInTheDocument();
    expect(screen.getByText('PR 1')).toBeInTheDocument();
    expect(screen.getByText('PR 2')).toBeInTheDocument();
    // Flat rows keep the repo name (InboxRow showRepo default stays true).
    expect(screen.getAllByText('acme/api').length).toBeGreaterThan(0);
    expect(screen.getAllByText('acme/web').length).toBeGreaterThan(0);
  });

  it('groupByRepo defaults on: multi-repo section still groups when the prop is omitted (#219)', () => {
    renderSection(
      makeSection('review-requested', [prFor('acme', 'api', 1), prFor('acme', 'web', 2)]),
    );
    expect(screen.getByRole('button', { name: /acme\/api, 1 pull request/i })).toBeInTheDocument();
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

describe('InboxSection forceOpen (expand-on-reveal)', () => {
  const section = makeSection('review-requested', [prFor('acme', 'api', 1)]);

  it('renders collapsed when forceOpen is false and defaultOpen is false', () => {
    renderForceOpen(section, { defaultOpen: false, forceOpen: false });
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review-requested/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('expands when forceOpen flips true even though defaultOpen is false', () => {
    const { rerender } = renderForceOpen(section, { defaultOpen: false, forceOpen: false });
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    rerender({ defaultOpen: false, forceOpen: true });
    expect(screen.getByText('PR 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review-requested/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('a manual collapse during forceOpen wins over forceOpen', () => {
    renderForceOpen(section, { defaultOpen: false, forceOpen: true });
    expect(screen.getByText('PR 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /review-requested/i }));
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
  });

  it('clearing forceOpen resets the section to its defaultOpen (drops manual-toggle memory)', () => {
    const { rerender } = renderForceOpen(section, { defaultOpen: false, forceOpen: true });
    // Manually collapse while forced open.
    fireEvent.click(screen.getByRole('button', { name: /review-requested/i }));
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    // Filter releases the section: forceOpen → false drops the manual memory,
    // so it returns to defaultOpen (false) → still collapsed here.
    rerender({ defaultOpen: false, forceOpen: false });
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    // Re-revealing forces it open again from the clean default.
    rerender({ defaultOpen: false, forceOpen: true });
    expect(screen.getByText('PR 1')).toBeInTheDocument();
  });
});
