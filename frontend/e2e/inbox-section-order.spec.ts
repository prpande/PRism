import { test, expect, type Route } from '@playwright/test';
import { makeDefaultPreferences } from './fixtures/preferences';
import { setupBaseRoutes } from './helpers/base-mocks';

// #275 — section reorder persists end-to-end: Settings → POST /api/preferences
// → inbox render honours the saved order across a reload. Pattern matches
// density-toggle.spec.ts exactly: mutable mock store, waitForResponse on the
// POST before asserting, then reload to prove persistence.

type Preferences = ReturnType<typeof makeDefaultPreferences> & {
  inbox: ReturnType<typeof makeDefaultPreferences>['inbox'] & { sectionOrder: string };
};

function makePrefsWithOrder(
  sectionOrder = 'authored-by-me,review-requested,awaiting-author,mentioned',
): Preferences {
  const base = makeDefaultPreferences();
  return {
    ...base,
    inbox: { ...base.inbox, sectionOrder },
  } as Preferences;
}

const sampleInbox = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [],
    },
    {
      id: 'awaiting-author',
      label: 'Needs re-review',
      items: [],
    },
    {
      id: 'authored-by-me',
      label: 'Authored by me',
      items: [],
    },
    {
      id: 'mentioned',
      label: 'Mentioned',
      items: [],
    },
    {
      id: 'recently-closed',
      label: 'Recently closed',
      items: [],
    },
  ],
  enrichments: {},
  lastRefreshedAt: new Date().toISOString(),
  ciProbeComplete: true,
  tokenScopeFooterEnabled: false,
  stale: false,
};

async function setupMocks(page: import('@playwright/test').Page) {
  const store: Preferences = makePrefsWithOrder();

  await setupBaseRoutes(page);

  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = (await route.request().postDataJSON()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'inbox.sectionOrder' && typeof value === 'string') {
          store.inbox.sectionOrder = value;
        }
      }
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(store),
    });
  });

  await page.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );

  return { store };
}

test.use({ viewport: { width: 1280, height: 800 } });

test('moving a section down in Settings reorders the inbox and persists across reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setupMocks(page);

  // Navigate to Settings → Inbox pane (same as settings-flow.spec.ts).
  await page.goto('/settings/inbox');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // Default order: authored-by-me, review-requested, awaiting-author, mentioned.
  // Click "Move Review requested down" → it swaps below awaiting-author, so awaiting-author
  // ends up before review-requested (which is what the assertions below check).
  const postPromise = page.waitForResponse(
    (r) => r.url().includes('/api/preferences') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Move Review requested down' }).click();
  await postPromise;

  // Navigate to the inbox and assert section header DOM order. The /api/inbox mock is
  // intentionally STATIC (it never echoes sectionOrder): inbox ordering is a pure
  // client-side sort (InboxPage runs orderInboxSections over the prefs), so the order
  // here is driven by the mutated /api/preferences store, not the inbox payload. If
  // ordering ever moves server-side, this mock would need to reflect it — without that,
  // the assertion would go vacuous rather than fail.
  // page.goto is a hard navigation, so it resets the routed-settings-modal state (the
  // modal does not bleed into the inbox we inspect below).
  await page.goto('/');

  // All four work-section headers are rendered as <button> elements whose text
  // contains the section label. Collect them in DOM order.
  // The inbox section header button contains the label as a <span> child.
  // We target buttons inside the section elements by their accessible text.
  const sectionButtons = page.locator(
    'main[data-testid="inbox-page"] section button[aria-expanded]',
  );
  await expect(sectionButtons.first()).toBeVisible({ timeout: 30_000 });

  const labels = await sectionButtons.allInnerTexts();
  // Strip counts (the button also contains the caret SVG and the count span).
  // The label span text comes first — split on whitespace and take the non-empty chunks.
  // We just assert that "Needs re-review" appears before "Review requested" in the list.
  const reviewIndex = labels.findIndex((t) => t.includes('Review requested'));
  const awaitingIndex = labels.findIndex((t) => t.includes('Needs re-review'));

  expect(reviewIndex).toBeGreaterThan(-1);
  expect(awaitingIndex).toBeGreaterThan(-1);
  expect(awaitingIndex).toBeLessThan(reviewIndex);

  // Reload and confirm the order persists (the mock store is mutated so the GET
  // after reload returns the new sectionOrder string).
  await page.reload();

  const sectionButtonsAfterReload = page.locator(
    'main[data-testid="inbox-page"] section button[aria-expanded]',
  );
  await expect(sectionButtonsAfterReload.first()).toBeVisible({ timeout: 30_000 });

  const labelsAfterReload = await sectionButtonsAfterReload.allInnerTexts();
  const reviewIndexAfterReload = labelsAfterReload.findIndex((t) => t.includes('Review requested'));
  const awaitingIndexAfterReload = labelsAfterReload.findIndex((t) =>
    t.includes('Needs re-review'),
  );

  expect(reviewIndexAfterReload).toBeGreaterThan(-1);
  expect(awaitingIndexAfterReload).toBeGreaterThan(-1);
  expect(awaitingIndexAfterReload).toBeLessThan(reviewIndexAfterReload);
});
