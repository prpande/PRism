import { test, expect, type Page, type Route } from '@playwright/test';
import { setupBaseRoutes } from './helpers/base-mocks';
import { makeDefaultPreferences } from './fixtures/preferences';

// ---------------------------------------------------------------------------
// #262 PR2 — inbox filter/sort bar e2e.
//
// Seeding mirrors inbox.spec.ts: setupBaseRoutes() wires the three constant
// routes (auth/state, capabilities, events), setupInbox adds the per-test
// `/api/preferences` + `/api/inbox` bodies. No fixture file or real backend —
// this is the established inbox-e2e seeding approach (route mocks), which lets
// us precisely control sections + per-PR CI so the CI facet has cross-section
// data and filters can empty sections / match nothing.
//
// The seeded `/api/inbox` payload carries the PR1 additions: `ciProbeComplete`
// at the top level and NO `ci-failing` section (it was removed as a section in
// PR1; CI is now a cross-cutting filter axis). At least one `ci: 'failing'` and
// one `ci: 'pending'` PR live in a NON-authored section (review-requested) so
// the CI facet spans sections.
// ---------------------------------------------------------------------------

type Ci = 'none' | 'pending' | 'failing';

function pr(opts: {
  owner?: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  ci?: Ci;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  commentCount?: number;
}) {
  const repoSlug = `${opts.owner ?? 'acme'}/${opts.repo}`;
  return {
    reference: { owner: opts.owner ?? 'acme', repo: opts.repo, number: opts.number },
    title: opts.title,
    author: opts.author,
    repo: repoSlug,
    updatedAt: opts.updatedAt ?? '2026-06-01T00:00:00Z',
    pushedAt: opts.updatedAt ?? '2026-06-01T00:00:00Z',
    iterationNumber: 1,
    commentCount: opts.commentCount ?? 0,
    additions: opts.additions ?? 10,
    deletions: opts.deletions ?? 1,
    headSha: `sha-${opts.repo}-${opts.number}`,
    ci: opts.ci ?? 'none',
    lastViewedHeadSha: null,
    lastSeenCommentId: null,
  };
}

// Cross-section CI data: review-requested (NON-authored) carries a failing AND
// a pending PR; authored-by-me carries a third failing PR. Free-text 'token'
// matches exactly one row. Enough breadth that a CI:failing filter empties the
// `mentioned` section (no failing PRs there) and a no-match text empties all.
const sampleInbox = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [
        pr({
          repo: 'api',
          number: 42,
          title: 'Refactor auth flow',
          author: 'amelia',
          ci: 'failing',
          updatedAt: '2026-06-05T00:00:00Z',
          additions: 80,
          deletions: 20,
          commentCount: 9,
        }),
        pr({
          repo: 'bff',
          number: 43,
          title: 'Wire pending checks',
          author: 'dana',
          ci: 'pending',
          // Older than #42 (so 'updated' ranks it second) but a MUCH larger diff
          // (so 'Diff size' ranks it FIRST) — this asymmetry is what makes the
          // sort test prove a genuine reorder, not just stable ordering.
          updatedAt: '2026-06-02T00:00:00Z',
          additions: 400,
          deletions: 90,
          commentCount: 2,
        }),
      ],
    },
    {
      id: 'awaiting-author',
      label: 'Needs re-review',
      items: [
        pr({
          repo: 'web',
          number: 50,
          title: 'Token refresh budget',
          author: 'dana',
          ci: 'none',
          updatedAt: '2026-06-03T00:00:00Z',
          additions: 30,
          deletions: 4,
          commentCount: 1,
        }),
      ],
    },
    {
      id: 'authored-by-me',
      label: 'Authored by me',
      items: [
        pr({
          repo: 'api',
          number: 60,
          title: 'Add retry budget',
          author: 'me',
          ci: 'failing',
          updatedAt: '2026-06-04T00:00:00Z',
          additions: 12,
          deletions: 2,
          commentCount: 0,
        }),
      ],
    },
    {
      id: 'mentioned',
      label: 'Mentioned',
      items: [
        pr({
          repo: 'web',
          number: 70,
          title: 'Docs sweep',
          author: 'pat',
          ci: 'none',
          updatedAt: '2026-06-01T00:00:00Z',
          additions: 3,
          deletions: 0,
          commentCount: 12,
        }),
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: new Date().toISOString(),
  tokenScopeFooterEnabled: true,
  // PR1 additions:
  ciProbeComplete: true,
};

// Canonical preferences shape (#332) with `ui.theme` parametrized per test so
// the filter behaviour is exercised in BOTH light and dark. The canonical
// `inbox.sections` is the PR1 taxonomy (no `ci-failing`, awaiting-author present).
function preferencesFor(theme: 'light' | 'dark') {
  const base = makeDefaultPreferences();
  return { ...base, ui: { ...base.ui, theme } };
}

// ---------------------------------------------------------------------------
// Shared mock wiring — the three constant routes via setupBaseRoutes, plus the
// per-test `/api/preferences` + `/api/inbox` stubs. `ciProbeComplete` override
// lets the incomplete-hint test flip it without rebuilding the body.
// ---------------------------------------------------------------------------

async function setupInbox(
  page: Page,
  opts: { theme: 'light' | 'dark'; ciProbeComplete?: boolean } = { theme: 'light' },
) {
  const inboxBody = {
    ...sampleInbox,
    ciProbeComplete: opts.ciProbeComplete ?? true,
  };
  await setupBaseRoutes(page);
  await page.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(preferencesFor(opts.theme)),
    }),
  );
  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(inboxBody),
    }),
  );
}

// Each section renders as a <button aria-expanded> header with the label text +
// an item-count span. Locate a section header button by its label.
function sectionHeader(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(label, 'i') }).first();
}

// ---------------------------------------------------------------------------
// Activity rail hides below 1180px; default 1280×800 keeps the layout stable.
// ---------------------------------------------------------------------------
test.use({ viewport: { width: 1280, height: 800 } });

// The filter behaviour is identical across themes (it's pure DOM/data), but we
// run the full suite in both light and dark to prove the bar/popover/zero-state
// render and respond under each color scheme. DOM/role assertions throughout —
// no pixel snapshots, so no Linux baseline to manage.
for (const theme of ['light', 'dark'] as const) {
  test.describe(`inbox filter/sort bar — ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await setupInbox(page, { theme });
      await page.goto('/');
      // Wait for the inbox to populate before touching the bar.
      await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });
      // Sanity: the requested theme actually resolved onto the document, so the
      // assertions below genuinely run under the intended color scheme.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(theme);
    });

    test('one merged input does both filter + paste-to-open', async ({ page }) => {
      // #262: the paste-URL box and the filter search were merged into ONE input.
      // It is a searchbox whose placeholder/label names both jobs, and there is
      // exactly one such input (no second stacked box).
      const merged = page.getByRole('searchbox', { name: /filter inbox, or paste a pr url/i });
      await expect(merged).toBeVisible();
      await expect(page.getByPlaceholder(/filter inbox, or paste a pr url/i)).toHaveCount(1);
    });

    test('free-text filter narrows rows live', async ({ page }) => {
      const search = page.getByRole('searchbox', { name: /filter inbox, or paste a pr url/i });
      // All five seeded PRs visible up front.
      await expect(page.getByText('Add retry budget')).toBeVisible();
      await expect(page.getByText('Docs sweep')).toBeVisible();

      await search.fill('token');

      // Only the one title containing "token" survives; others drop live.
      await expect(page.getByText('Token refresh budget')).toBeVisible();
      await expect(page.getByText('Refactor auth flow')).toBeHidden();
      await expect(page.getByText('Docs sweep')).toBeHidden();

      // Summary status reflects the live match count.
      await expect(page.getByRole('status').filter({ hasText: /showing/i })).toContainText(
        /showing 1 of 5 PRs/i,
      );
    });

    test('CI facet filters failing across sections; emptied sections hide then re-reveal EXPANDED', async ({
      page,
    }) => {
      // Two failing PRs live in DIFFERENT sections: review-requested (#42) and
      // authored-by-me (#60). The CI facet must keep both and drop the rest.
      const ciTrigger = page.getByRole('button', { name: /^CI/ });
      await ciTrigger.click();

      // The popover stays OPEN after a check (only an outside-click / Escape /
      // trigger-click closes it), so the same popover is reused for the uncheck.
      const ciPopover = page.getByRole('group', { name: /CI filter/i });
      await ciPopover.getByRole('checkbox', { name: 'failing' }).check();

      // Cross-section failing rows remain; non-failing rows drop.
      await expect(page.getByText('Refactor auth flow')).toBeVisible(); // review-requested, failing
      await expect(page.getByText('Add retry budget')).toBeVisible(); // authored-by-me, failing
      await expect(page.getByText('Wire pending checks')).toBeHidden(); // pending, dropped
      await expect(page.getByText('Token refresh budget')).toBeHidden(); // none, dropped

      // The `mentioned` section had no failing PR → its header is now hidden.
      await expect(sectionHeader(page, 'Mentioned')).toBeHidden();
      await expect(sectionHeader(page, 'Needs re-review')).toBeHidden(); // awaiting-author emptied under CI:failing
      // Sections that still have matches remain.
      await expect(sectionHeader(page, 'Review requested')).toBeVisible();
      await expect(sectionHeader(page, 'Authored by me')).toBeVisible();

      // Clearing the filter re-reveals the emptied section, EXPANDED (forceOpen
      // keeps revealed sections open). The popover is still open, so uncheck in
      // place — no re-open click (that would CLOSE the still-open popover).
      await ciPopover.getByRole('checkbox', { name: 'failing' }).uncheck();

      const mentioned = sectionHeader(page, 'Mentioned');
      await expect(mentioned).toBeVisible();
      await expect(mentioned).toHaveAttribute('aria-expanded', 'true');
      // Its row is visible again (expanded, not collapsed).
      await expect(page.getByText('Docs sweep')).toBeVisible();
    });

    test('all-match-nothing shows the "No PRs match your filters" zero-state', async ({ page }) => {
      const search = page.getByRole('searchbox', { name: /filter inbox, or paste a pr url/i });
      await search.fill('zzz-no-such-pr');

      // Every section is emptied → the dedicated zero-state renders, and no row
      // or section header remains.
      await expect(page.getByText(/No PRs match your filters/i)).toBeVisible();
      await expect(page.getByText('Refactor auth flow')).toBeHidden();
      await expect(sectionHeader(page, 'Review requested')).toBeHidden();

      // Clearing from the zero-state restores everything.
      await page
        .getByText(/No PRs match your filters/i)
        .getByRole('button', { name: /clear/i })
        .click();
      await expect(page.getByText('Refactor auth flow')).toBeVisible();
      await expect(sectionHeader(page, 'Review requested')).toBeVisible();
    });

    test('sort reorders rows within a section', async ({ page }) => {
      // review-requested holds two PRs whose ranking DISAGREES by axis:
      //   #42 "Refactor auth flow"  — newer (06-05), diff 100
      //   #43 "Wire pending checks" — older (06-02), diff 490
      // 'updated' DESC ranks #42 first; 'Diff size' DESC ranks #43 first — a
      // genuine swap, which is what proves the sort actually reorders.
      const sortSelect = page.getByRole('combobox');

      // DOM order of the two review-requested titles (top-to-bottom).
      const order = async () => {
        const yRefactor = await page
          .getByText('Refactor auth flow')
          .evaluate((el) => el.getBoundingClientRect().top);
        const yPending = await page
          .getByText('Wire pending checks')
          .evaluate((el) => el.getBoundingClientRect().top);
        return yRefactor < yPending ? ['refactor', 'pending'] : ['pending', 'refactor'];
      };

      // Default 'updated': newer #42 leads.
      expect(await order()).toEqual(['refactor', 'pending']);

      // 'Diff size' DESC: the larger #43 now leads — the rows swapped.
      await sortSelect.selectOption('diff');
      await expect.poll(order).toEqual(['pending', 'refactor']);

      // Back to 'updated': #42 leads again.
      await sortSelect.selectOption('updated');
      await expect.poll(order).toEqual(['refactor', 'pending']);
    });

    test('CI-incomplete hint surfaces when ciProbeComplete is false', async ({ page }) => {
      // Re-seed with an incomplete probe + activate a filter so the summary
      // (which only renders while a filter is active) shows the hint.
      await setupInbox(page, { theme, ciProbeComplete: false });
      await page.goto('/');
      await expect(page.getByText('Refactor auth flow')).toBeVisible({ timeout: 30_000 });

      await page.getByRole('searchbox', { name: /filter inbox, or paste a pr url/i }).fill('a');
      await expect(page.getByRole('status').filter({ hasText: /CI status/i })).toContainText(
        /CI status may be incomplete/i,
      );
    });
  });
}
