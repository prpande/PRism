import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { InboxRow } from './InboxRow';
import { prId } from './groupByRepo';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';

const PR: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 99 },
  title: 'Add user pagination',
  author: 'alice',
  repo: 'acme/api',
  updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(),
  commitCount: 2,
  changedFiles: 3,
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
  isDraft: false,
  mergeReadiness: 'none',
  approvals: null,
  changesRequested: null,
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
        <InboxRow
          pr={pr}
          showCategoryChip={false}
          maxDiff={100}
          settled={new Set<string>()}
          {...props}
        />
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
                <InboxRow
                  pr={PR}
                  enrichment={undefined}
                  showCategoryChip={false}
                  maxDiff={100}
                  settled={new Set<string>()}
                />
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
          <InboxRow
            pr={PR}
            enrichment={undefined}
            showCategoryChip={false}
            maxDiff={100}
            settled={new Set<string>()}
          />
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

  it('renders the closed glyph + aria for a closed PR (no text badge)', () => {
    const { container } = renderInboxRow({ ...PR, closedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="closed"]')).not.toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();
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
          <InboxRow
            pr={PR}
            showCategoryChip={false}
            maxDiff={100}
            showRepo={showRepo}
            settled={new Set<string>()}
          />
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

describe('InboxRow Draft chip', () => {
  it('renders a Draft chip for open draft PRs with AI off', () => {
    renderInboxRow({ ...PR, isDraft: true }, { showCategoryChip: false });
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByText('AI')).not.toBeInTheDocument();
  });

  it('draft PR shows Draft, not an AI category chip', () => {
    renderInboxRow(
      { ...PR, isDraft: true },
      {
        showCategoryChip: true,
        enrichment: { prId: 'x', categoryChip: 'Feature', hoverSummary: null },
      },
    );
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByText('Feature')).not.toBeInTheDocument();
  });

  it('non-draft PR shows the AI category chip', () => {
    renderInboxRow(
      { ...PR, isDraft: false },
      {
        showCategoryChip: true,
        enrichment: { prId: 'x', categoryChip: 'Feature', hoverSummary: null },
        settled: new Set([prId(PR)]),
      },
    );
    expect(screen.getByText('Feature')).toBeInTheDocument();
    // #489: the chip marker is now an AiMarker icon (not literal "AI" text).
    expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
  });
});

describe('InboxRow chip + badge placement (on the meta line, not the metrics tail)', () => {
  it('renders the AI category chip on the meta line, not inside the metrics tail', () => {
    renderInboxRow(PR, {
      showCategoryChip: true,
      enrichment: { prId: 'x', categoryChip: 'Refactor', hoverSummary: null },
      settled: new Set([prId(PR)]),
    });
    const chip = screen.getByText('Refactor');
    // chip lives in the elastic meta line so it's always visible, and is NOT in
    // the fixed-width metrics tail (where it would be clipped — see #227 B1)
    expect(chip.closest('[class*="meta"]')).not.toBeNull();
    expect(chip.closest('[class*="tail"]')).toBeNull();
    // #489: the chip marker is now an AiMarker icon (not literal "AI" text).
    expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
  });

  it('shows merged state via the leading icon + aria, not a meta-line badge', () => {
    const { container } = renderInboxRow({ ...PR, mergedAt: new Date().toISOString() });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(screen.queryByText('Merged')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('· merged');
  });
});

// Merged here from the former frontend/__tests__/InboxRow.test.tsx. The
// navigate-on-click, CI-failing-glyph, shows-merged-state, category-chip-when-true,
// and no-CI-on-done cases from that file were assertion-subsets of the cases above
// (opens-tab, the CI-suffix-glyph block, the PR-state-leading-icon block, the
// chip+badge-placement test, and the CI-suffix done case), so only the unique
// unread / New-badge / age coverage is carried over.
describe('InboxRow unread bar, New-badge removal, and age', () => {
  it('renders title, repo, author, age', () => {
    renderInboxRow(PR);
    expect(screen.getByText('Add user pagination')).toBeInTheDocument();
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  // #121/#122: the "New" badge is gone; the left accent bar (data-unread) is the
  // single new-activity indicator, driven by "commits since you last viewed",
  // not 30-min recency.
  it('no longer renders the "New" badge', () => {
    renderInboxRow(PR);
    expect(screen.queryByText('New')).toBeNull();
  });

  it('marks unread when the head moved since last view', () => {
    renderInboxRow({ ...PR, lastViewedHeadSha: 'old', headSha: 'new' });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(row.getAttribute('aria-label')).toContain('unread');
  });

  it('is NOT unread when viewed head matches current head', () => {
    renderInboxRow({ ...PR, lastViewedHeadSha: 'same', headSha: 'same' });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'false');
    expect(row.getAttribute('aria-label')).not.toContain('unread');
  });

  it('IS unread for a never-opened PR (lastViewedHeadSha null) — its current state is unseen', () => {
    renderInboxRow({ ...PR, lastViewedHeadSha: null, headSha: 'abc' });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(row.getAttribute('aria-label')).toContain('unread');
  });

  it('is NOT unread for a merged PR even if the head moved', () => {
    renderInboxRow({
      ...PR,
      lastViewedHeadSha: 'old',
      headSha: 'new',
      mergedAt: new Date().toISOString(),
    });
    const row = screen.getByRole('button');
    expect(row).toHaveAttribute('data-unread', 'false');
    expect(row.getAttribute('aria-label')).not.toContain('unread');
  });

  it('is NOT unread for a closed PR even if the head moved', () => {
    renderInboxRow({
      ...PR,
      lastViewedHeadSha: 'old',
      headSha: 'new',
      closedAt: new Date().toISOString(),
    });
    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'false');
  });

  it('does not render category chip when showCategoryChip is false', () => {
    const enrichment: InboxItemEnrichment = {
      prId: 'acme/api#99',
      categoryChip: 'Refactor',
      hoverSummary: null,
    };
    renderInboxRow(PR, { showCategoryChip: false, enrichment });
    expect(screen.queryByText('Refactor')).not.toBeInTheDocument();
  });

  it('renders friendly age text for very recent PRs', () => {
    renderInboxRow({ ...PR, updatedAt: new Date().toISOString() });
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it('does not show the New chip on a done row even when lastViewedHeadSha is null', () => {
    renderInboxRow({ ...PR, lastViewedHeadSha: null, mergedAt: new Date().toISOString() });
    expect(screen.queryByText('New')).not.toBeInTheDocument();
    // ...and the unread bar is suppressed too (done rows never flag).
    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'false');
  });
});

describe('InboxRow changed-files slot', () => {
  it('renders changed-files count in the tail metrics', () => {
    const { container } = renderInboxRow({ ...PR, changedFiles: 5 });
    const filesSlot = container.querySelector('[class*="filesSlot"]');
    expect(filesSlot).not.toBeNull();
    expect(filesSlot!.textContent).toContain('5');
    // count is rendered next to an aria-hidden SVG glyph
    expect(filesSlot!.querySelector('svg')).not.toBeNull();
  });

  it('does not render files count when changedFiles is 0', () => {
    const { container } = renderInboxRow({ ...PR, changedFiles: 0 });
    const filesSlot = container.querySelector('[class*="filesSlot"]');
    expect(filesSlot).not.toBeNull();
    expect(filesSlot!.querySelector('[class*="files"]')).toBeNull();
    expect(filesSlot!.textContent).toBe('');
    // queryByText with exact match: the standalone "0" file count must not appear
    expect(screen.queryByText('0')).toBeNull();
  });
});

describe('InboxRow draft treatment (#501)', () => {
  it('renders the draft glyph and draft aria-label for an open draft row', () => {
    const { container } = renderInboxRow({ ...PR, isDraft: true });
    // status glyph switches to the draft discriminant
    expect(container.querySelector('[data-pr-state="draft"]')).not.toBeNull();
    // aria-label carries "· draft" in the state slot (replacing "· open")
    const row = screen.getByRole('button', { name: /Add user pagination/i });
    expect(row.getAttribute('aria-label')).toContain('· draft ·');
    expect(row.getAttribute('aria-label')).not.toContain('· open ·');
  });

  it('renders the info draft chip for an open draft row', () => {
    const { container } = renderInboxRow({ ...PR, isDraft: true });
    expect(container.querySelector(`.${'draftChip'}`) ?? screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('a merged draft renders as merged (precedence), not draft', () => {
    const { container } = renderInboxRow({
      ...PR,
      isDraft: true,
      mergedAt: new Date().toISOString(),
    });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(container.querySelector('[data-pr-state="draft"]')).toBeNull();
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('a non-draft open row is unchanged (open glyph, open aria, no Draft chip)', () => {
    const { container } = renderInboxRow({ ...PR, isDraft: false });
    expect(container.querySelector('[data-pr-state="open"]')).not.toBeNull();
    expect(screen.queryByText('Draft')).toBeNull();
    const row = screen.getByRole('button', { name: /Add user pagination/i });
    expect(row.getAttribute('aria-label')).toContain('· open ·');
  });
});

describe('InboxRow AI chip: provenance in aria-label', () => {
  it('AI category chip: icon replaces the "AI" text and provenance rides the row aria-label', () => {
    renderInboxRow(PR, {
      showCategoryChip: true,
      enrichment: { prId: 'acme/api#99', categoryChip: 'Refactor', hoverSummary: 's' },
      settled: new Set([prId(PR)]),
    });
    const row = screen.getByRole('button');
    expect(row).toHaveAccessibleName(/AI-generated/); // provenance via accessible name
    expect(screen.getByTestId('ai-marker')).toBeInTheDocument(); // icon, not literal "AI"
    expect(screen.getByText('Refactor')).toBeInTheDocument();
  });

  it('no AI provenance in the aria-label when the chip is hidden', () => {
    renderInboxRow(PR, {
      showCategoryChip: false,
      enrichment: { prId: 'acme/api#99', categoryChip: 'Refactor', hoverSummary: 's' },
    });
    expect(screen.getByRole('button')).not.toHaveAccessibleName(/AI-generated/);
  });
});

// ---- Task 6 (#508, #548): chip-slot working marker while enrichment is unsettled ----

const ID = prId(PR); // 'acme/api#99'

function renderRow(
  opts: {
    done?: boolean;
    showCategoryChip?: boolean;
    enrichment?: InboxItemEnrichment;
    settled?: ReadonlySet<string>;
  } = {},
) {
  const pr: PrInboxItem = opts.done ? { ...PR, mergedAt: new Date().toISOString() } : PR;
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <InboxRow
          pr={pr}
          showCategoryChip={opts.showCategoryChip ?? false}
          maxDiff={100}
          enrichment={opts.enrichment}
          settled={opts.settled ?? new Set<string>()}
        />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('InboxRow #593 readiness + #516 number', () => {
  it('renders the PR number as a mono prefix on every row', () => {
    renderInboxRow({ ...PR, reference: { owner: 'acme', repo: 'api', number: 12345 } });
    expect(screen.getByText('#12345')).toBeInTheDocument();
  });

  it('renders the readiness badge for an open state and appends it to the aria-label', () => {
    renderInboxRow({ ...PR, mergeReadiness: 'conflicts' });
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
    // The badge renders a button with "Merge readiness: Conflicts"; the row button's
    // aria-label also contains "Conflicts" via readinessSuffix — use the badge-specific label.
    expect(screen.getByRole('button', { name: /Merge readiness: Conflicts/ })).toBeInTheDocument();
  });

  it('renders NO readiness badge for merged/closed/draft/none', () => {
    for (const pr of [
      { ...PR, mergedAt: new Date().toISOString(), mergeReadiness: 'merged' as const },
      { ...PR, closedAt: new Date().toISOString(), mergeReadiness: 'closed' as const },
      { ...PR, isDraft: true, mergeReadiness: 'none' as const },
      { ...PR, mergeReadiness: 'none' as const },
    ]) {
      const { container, unmount } = renderInboxRow(pr);
      expect(container.querySelector('[data-readiness]')).toBeNull();
      unmount();
    }
  });

  it('reserves the fixed-width CI slot even when ci is none (alignment contract)', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'none' });
    const slot = container.querySelector('[data-ci-slot]');
    expect(slot).not.toBeNull(); // slot present (empty spacer), so numbers/titles align
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[data-ci]')).toBeNull(); // but no octicon
  });

  it('renders the CI octicon inside the leading slot when present', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing' });
    const slot = container.querySelector('[data-ci-slot]');
    expect(slot?.querySelector('[data-ci="failing"]')).not.toBeNull();
  });

  it('still announces CI status via the row aria-label for a failing-CI row (slot is aria-hidden)', () => {
    // The CI slot/octicon is aria-hidden; CI semantics must reach SR via ciSuffix on the row label.
    renderInboxRow({ ...PR, ci: 'failing' });
    expect(screen.getByRole('button', { name: /CI failing/ })).toBeInTheDocument();
  });
});

describe('InboxRow chip-slot working marker (#508, #548)', () => {
  it('shows a working marker in the chip slot while enrichment is unsettled', () => {
    renderRow({ showCategoryChip: true, enrichment: undefined, settled: new Set<string>() });
    expect(screen.getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'working');
  });

  it('renders the chip (idle marker) once settled with a chip', () => {
    renderRow({
      showCategoryChip: true,
      enrichment: { prId: ID, categoryChip: 'Refactor', hoverSummary: null },
      settled: new Set([ID]),
    });
    expect(screen.getByText('Refactor')).toBeInTheDocument();
    expect(screen.getByTestId('ai-marker')).toHaveAttribute('data-ai-state', 'idle');
  });

  it('renders nothing in the chip slot once settled with no chip', () => {
    renderRow({ showCategoryChip: true, enrichment: undefined, settled: new Set([ID]) });
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  });

  it('renders nothing when the chip feature is off, even while unsettled', () => {
    renderRow({ showCategoryChip: false, enrichment: undefined, settled: new Set<string>() });
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  });

  it('announces the in-flight state on the row aria-label while loading', () => {
    renderRow({ showCategoryChip: true, enrichment: undefined, settled: new Set<string>() });
    expect(screen.getByRole('button')).toHaveAccessibleName(/categoriz/i);
  });

  it('announces the in-flight state on a merged/closed (done) PR too — both aria-label branches', () => {
    renderRow({
      done: true,
      showCategoryChip: true,
      enrichment: undefined,
      settled: new Set<string>(),
    });
    expect(screen.getByRole('button')).toHaveAccessibleName(/categoriz/i);
  });

  it('draft PR does not show category working marker even while unsettled', () => {
    render(
      <MemoryRouter>
        <OpenTabsProvider>
          <InboxRow
            pr={{ ...PR, isDraft: true }}
            showCategoryChip={true}
            maxDiff={100}
            enrichment={undefined}
            settled={new Set<string>()}
          />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    // Draft chip wins — no AI working marker
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  });
});
