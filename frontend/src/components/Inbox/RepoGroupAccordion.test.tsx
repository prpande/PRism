import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { RepoGroupAccordion } from './RepoGroupAccordion';
import type { PrInboxItem } from '../../api/types';

function pr(n: number): PrInboxItem {
  return {
    reference: { owner: 'acme', repo: 'api', number: n },
    title: `PR ${n}`,
    author: 'a',
    repo: 'acme/api',
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
    isDraft: false,
  };
}
const group = { repo: 'acme/api', items: [pr(1), pr(2)] };

function renderAcc(defaultOpen: boolean) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <RepoGroupAccordion
          group={group}
          enrichments={{}}
          showCategoryChip={false}
          maxDiff={100}
          defaultOpen={defaultOpen}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('RepoGroupAccordion', () => {
  it('shows repo name + count badge in an accessible label', () => {
    renderAcc(true);
    expect(screen.getByRole('button', { name: /acme\/api, 2 pull requests/i })).toBeInTheDocument();
  });

  it('uses the singular "1 pull request" (no trailing s) for a single-PR group', () => {
    render(
      <MemoryRouter>
        <OpenTabsProvider>
          <RepoGroupAccordion
            group={{ repo: 'acme/api', items: [pr(1)] }}
            enrichments={{}}
            showCategoryChip={false}
            maxDiff={100}
            defaultOpen={false}
          />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'acme/api, 1 pull request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /1 pull requests/i })).not.toBeInTheDocument();
  });

  it('renders rows only when open', async () => {
    renderAcc(false);
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /acme\/api/i }));
    expect(screen.getByText('PR 1')).toBeInTheDocument();
  });

  it('rows inside the group omit the repo span (repo shown once, in the header)', () => {
    renderAcc(true);
    expect(screen.getAllByText('acme/api')).toHaveLength(1);
  });

  it('renders its nested rows as grouped (data-grouped=true)', () => {
    const { container } = renderAcc(true);
    const rows = container.querySelectorAll('button[data-grouped="true"]');
    expect(rows.length).toBe(2); // the shared `group` const has 2 items
  });
});
