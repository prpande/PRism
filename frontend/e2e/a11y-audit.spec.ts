import { test, expect, type Route, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

// ---------------------------------------------------------------------------
// Spec § 6 — Accessibility baseline audit (Pass 1: automated axe-core).
//
// One spec, many tests. Each visits a top-level surface, waits for the page
// to settle, then runs axe-core and asserts zero violations at "serious" or
// "critical" impact. "moderate" and "minor" findings are surfaced in the
// failure message when blockers exist but do not themselves block.
//
// Scope (spec § 6.1): /setup, /, /pr/{ref}, /pr/{ref}/files, /pr/{ref}/drafts,
// /settings/appearance (the Settings modal, #134), plus the cheatsheet-open
// state on any page (we use /).
//
// The PR6 prefers-reduced-motion verification is folded in here per the
// plan's "PR6 e2e or accessibility audit" deferral: the LoadingScreen
// component must suppress its pulse animation under
// `prefers-reduced-motion: reduce`.
// ---------------------------------------------------------------------------

const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
};

const defaultPreferences = {
  ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
  inbox: {
    sections: {
      'review-requested': true,
      'awaiting-author': true,
      'authored-by-me': true,
      mentioned: true,
      'ci-failing': true,
    },
  },
  github: {
    host: 'https://github.com',
    // Fixture-only sentinel paths — the Settings page just renders these as
    // copyable strings, axe-core doesn't care, and using a clearly synthetic
    // value avoids implying any real platform's data-dir layout.
    configPath: '<dataDir>/config.json',
    logsPath: '<dataDir>/logs',
  },
};

const allOffCapabilities = {
  ai: {
    summary: false,
    fileFocus: false,
    hunkAnnotations: false,
    preSubmitValidators: false,
    composerAssist: false,
    draftSuggestions: false,
    draftReconciliation: false,
    inboxEnrichment: false,
    inboxRanking: false,
  },
};

// Fixed timestamps for deterministic axe-core runs — `InboxRow.formatAge()`
// uses `Date.now() - updatedAt`, so a fixed timestamp close to "now" still
// renders different strings ("just now" / "1h ago" / …) as wall-clock time
// moves, and a future timestamp produces a negative delta. Pin to a far-past
// constant so the rendered age string is stably 'older' (delta > 24h on every
// realistic run) and the accessible-name text is byte-stable across runs.
const FIXED_TS = '2024-01-01T00:00:00.000Z';

const sampleInbox = {
  sections: [
    {
      id: 'review-requested',
      label: 'Review requested',
      items: [
        {
          reference: { owner: 'octocat', repo: 'Hello-World', number: 1 },
          title: 'Sample pull request for a11y audit',
          author: 'amelia',
          repo: 'octocat/Hello-World',
          updatedAt: FIXED_TS,
          pushedAt: FIXED_TS,
          iterationNumber: 1,
          commentCount: 3,
          additions: 25,
          deletions: 4,
          headSha: 'abc',
          ci: 'none',
          lastViewedHeadSha: null,
          lastSeenCommentId: null,
        },
      ],
    },
  ],
  enrichments: {},
  lastRefreshedAt: FIXED_TS,
  tokenScopeFooterEnabled: true,
};

const samplePrDetail = {
  pr: {
    reference: { owner: 'octocat', repo: 'Hello-World', number: 1 },
    title: 'Sample pull request for a11y audit',
    body: 'A small PR used as the a11y-audit fixture.',
    author: 'octocat',
    state: 'open',
    headSha: 'abc',
    baseSha: 'def',
    headBranch: 'feature/x',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: FIXED_TS,
  },
  clusteringQuality: 'ok',
  iterations: [],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

// ReviewSessionDto-shaped fixture (matches frontend/src/api/types.ts) — the
// PrDetailPage crashes into its ErrorBoundary if the draft session response
// doesn't match this shape, which would shadow the axe-core findings we
// actually want to surface on the PR detail surfaces.
const emptyDraftSession = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

async function setupBaseMocks(p: Page): Promise<void> {
  await p.route('**/api/auth/state', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authedAuthState),
    }),
  );
  await p.route('**/api/preferences', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(defaultPreferences),
    }),
  );
  await p.route('**/api/capabilities', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(allOffCapabilities),
    }),
  );
  await p.route('**/api/events', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':heartbeat\n\n' }),
  );
  await p.route('**/api/inbox', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleInbox),
    }),
  );
  // Wire shape matches PRism.Web/Endpoints/SubmitInFlightEndpoint.cs:
  //   SubmitInFlightResponse(bool InFlight, string? PrRef)
  // i.e. `{ inFlight: bool, prRef: string|null }` — singular, NOT `refs: []`.
  // Even though inFlight=false makes prRef dormant here, contract-accuracy
  // keeps the mock from masking future integration regressions.
  await p.route('**/api/submit/in-flight', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ inFlight: false, prRef: null }),
    }),
  );
  // PR detail (GET on the base ref returns the detail DTO; the same path with
  // /draft suffix returns the draft session for the Drafts tab).
  await p.route('**/api/pr/octocat/Hello-World/1', (route: Route) => {
    if (route.request().method() === 'POST' || route.request().method() === 'PUT') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(samplePrDetail),
    });
  });
  await p.route('**/api/pr/octocat/Hello-World/1/draft', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyDraftSession),
    }),
  );
  await p.route('**/api/pr/octocat/Hello-World/1/mark-viewed', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  // Files tab issues a diff fetch keyed by commit range; a non-empty empty-diff
  // response keeps the tab rendering without hitting an error placeholder.
  await p.route('**/api/pr/octocat/Hello-World/1/diff**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [], truncated: false }),
    }),
  );
}

// D104 (tracked in #174): the PrTabStrip "deletable tabs" pattern places the
// close <button aria-label="Close tab"> as a child of role="tablist", tripping
// aria-required-children (critical) on every PR-detail surface that shows an
// open tab. It is an inherent WAI-ARIA "tabs + action button" gap; the clean
// fix is the roving-tabindex + Delete-key redesign deferred to D85. Allowlist
// ONLY this exact violation (nodes belonging to the [data-testid="pr-tabstrip"]
// tablist) so the audit still gates every OTHER surface and rule. Remove this
// helper + filter once #174 lands.
function isKnownTabStripCloseButtonViolation(v: {
  id: string;
  nodes: { html: string }[];
}): boolean {
  return (
    v.id === 'aria-required-children' &&
    v.nodes.length > 0 &&
    v.nodes.every((n) => n.html.includes('data-testid="pr-tabstrip"'))
  );
}

async function runAxe(p: Page): Promise<void> {
  const results = await new AxeBuilder({ page: p }).analyze();
  const blockers = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .filter((v) => !isKnownTabStripCloseButtonViolation(v));
  // Gate ONLY on serious/critical (minus the allowlisted D104 trade), but
  // stringify ALL violations into the failure message so any co-occurring
  // moderate/minor findings are visible for diagnosis.
  expect(blockers, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('A11y audit — automated axe-core pass per spec § 6', () => {
  test('setup (/setup) — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    // Setup screen renders even with hasToken=true; redirect off it lands on
    // / when authed, so we mock the no-token branch for /setup specifically.
    await page.unroute('**/api/auth/state');
    await page.route('**/api/auth/state', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      }),
    );
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible({
      timeout: 30_000,
    });
    await runAxe(page);
  });

  test('inbox (/) — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/');
    await expect(page.getByText('Sample pull request for a11y audit')).toBeVisible({
      timeout: 30_000,
    });
    await runAxe(page);
  });

  test('PR overview (/pr/octocat/Hello-World/1) — no serious/critical violations', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    await runAxe(page);
  });

  test('PR files (/pr/octocat/Hello-World/1/files) — no serious/critical violations', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1/files');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    await runAxe(page);
  });

  // ---------------------------------------------------------------------------
  // Spec § 6 (Task 10) — highlighted diff must not introduce new axe violations.
  //
  // The base setupBaseMocks returns an empty diff ({files:[]}) so the
  // /pr/.../1/files test above never exercises HighlightedLine / .codeToken
  // spans. This test overrides that route with a real .ts hunk that forces
  // pathToLang → TypeScript grammar → Shiki token expansion, including a
  // context line, a paired delete/insert (word-diff background classes), and
  // a solo insert — covering all three HighlightedLine code paths. The single
  // file auto-selects via the FilesTab useEffect (fileList[0]), so no
  // tree-row click is needed.
  // ---------------------------------------------------------------------------
  test('PR files — highlighted diff (.codeToken spans) — no serious/critical violations', async ({
    page,
  }) => {
    // Fixture: one .ts file with a mixed hunk to exercise all highlight paths.
    const highlightedDiff = {
      range: 'abc..def',
      truncated: false,
      files: [
        {
          path: 'sample.ts',
          status: 'modified',
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 3,
              body: '@@ -1,2 +1,3 @@\n const greeting = "hello";\n-const count = 1;\n+const count = 2;\n+const done = true;',
            },
          ],
        },
      ],
    };

    await setupBaseMocks(page);
    // Override the empty-diff mock with the highlightable fixture.
    await page.unroute('**/api/pr/octocat/Hello-World/1/diff**');
    await page.route('**/api/pr/octocat/Hello-World/1/diff**', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(highlightedDiff),
      }),
    );

    await page.goto('/pr/octocat/Hello-World/1/files');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    // The single file auto-selects (FilesTab useEffect sets selectedPath =
    // fileList[0]). Wait for Shiki to resolve and .codeToken spans to render.
    await expect(page.locator('.codeToken').first()).toBeVisible({ timeout: 30_000 });

    // Scope axe to the diff container so this assertion isolates the HIGHLIGHTED
    // diff itself. The page-wide audit (the /files test above) covers the
    // surrounding chrome, which currently carries pre-existing serious findings
    // unrelated to syntax highlighting — aria-required-children on the PR tab
    // strip (tracked for issue #126) and color-contrast on the verdict picker.
    //
    // `color-contrast` is intentionally disabled for THIS scoped audit. Syntax
    // highlighting paints muted token colors (comments, strings) that can fall
    // below WCAG AA 4.5:1 over the green/red diff add/delete backgrounds — an
    // accepted, documented tradeoff inherent to highlighting code on tinted
    // diff rows (GitHub/GitLab/VS Code share it). It is tracked for a follow-up
    // mitigation; see docs/plans/2026-06-04-pr-detail-syntax-highlighting.md
    // ("Known limitations"). With contrast set aside, this test proves the real
    // Task-10 invariant: the .codeLine / .codeToken span structure introduces NO
    // new ARIA / structural serious/critical violations (token spans carry text
    // children, so each row's accessible name is unchanged). All non-disabled
    // diff-pane violations are stringified into the failure message for
    // diagnosis.
    const results = await new AxeBuilder({ page })
      .include('[data-testid="diff-pane"]')
      .disableRules(['color-contrast'])
      .analyze();
    const blockers = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(blockers, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('PR files — collapsed header — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1/files');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    // Collapse the PR-detail header. The chevron must remain a SIBLING of the
    // tablist (not inside it) — collapsing and re-auditing here catches any
    // regression where someone moves the button into [role="tablist"], which
    // would trip axe's aria-required-children critical rule.
    await page.locator('[data-testid="pr-header-collapse-toggle"]').click();
    await expect(page.locator('[data-testid="pr-header"]')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
    await runAxe(page);
  });

  test('PR drafts (/pr/octocat/Hello-World/1/drafts) — no serious/critical violations', async ({
    page,
  }) => {
    await setupBaseMocks(page);
    await page.goto('/pr/octocat/Hello-World/1/drafts');
    await expect(
      page.getByRole('heading', { name: /sample pull request for a11y audit/i }),
    ).toBeVisible({ timeout: 30_000 });
    await runAxe(page);
  });

  test('settings (/settings/appearance) — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    // #134: Settings is a modal over a background location; the appearance pane
    // is the cold-deep-link target. Audit covers the modal + the Inbox behind it.
    await page.goto('/settings/appearance');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /appearance/i, level: 2 })).toBeVisible();
    await runAxe(page);
  });

  test('cheatsheet open — no serious/critical violations', async ({ page }) => {
    await setupBaseMocks(page);
    await page.goto('/');
    await expect(page.getByText('Sample pull request for a11y audit')).toBeVisible({
      timeout: 30_000,
    });
    // Move focus off the URL-paste input so `?` is not typed into a text field.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
    await runAxe(page);
  });
});

// ---------------------------------------------------------------------------
// LoadingScreen brand mark is static (never pulses). The activity cue is the
// decorative spinner, whose own reduced-motion behavior is covered by the
// Spinner suite below. Here we just assert the brand logo carries no animation,
// so a pulsing/flashing logo can never regress back in.
//
// The LoadingScreen renders during the brief window between App mount and the
// /api/auth/state response. We delay that response indefinitely so the screen
// stays mounted long enough for the assertion.
// ---------------------------------------------------------------------------

// Helper for routes that should hang for the test duration. Awaiting a
// never-resolving Promise makes the "request stays pending" contract explicit
// rather than relying on the implicit Playwright semantics of a sync handler
// that doesn't call fulfill/continue/abort — which is non-obvious to read and
// brittle to a future Playwright upgrade.
const HANG_FOREVER = async () => {
  await new Promise<void>(() => {
    /* never resolves; cleanup happens at page close */
  });
};

test.describe('A11y audit — LoadingScreen brand mark is static', () => {
  test('the logo has no animation; motion is delegated to the spinner', async ({ page }) => {
    // Hold the auth response open so the LoadingScreen stays visible. useAuth
    // stays in its pending state and App renders <LoadingScreen />.
    await page.route('**/api/auth/state', HANG_FOREVER);
    await page.goto('/');
    const loadingRegion = page.getByRole('status').first();
    await expect(loadingRegion).toBeVisible({ timeout: 5_000 });
    // Bind by CSS-modules-hashed class substring. The static brand mark is the
    // only <img> on the screen (the background watermark was removed).
    const logo = loadingRegion.locator('img[class*="logo"]');
    await expect(logo).toBeVisible();
    const animationName = await logo.evaluate((el) => window.getComputedStyle(el).animationName);
    expect(animationName).toBe('none');
    // The decorative spinner ring provides the activity cue while loading.
    await expect(loadingRegion.locator('span[class*="ring"]')).toBeVisible();
  });
});

test.describe('A11y audit — Spinner honors prefers-reduced-motion (#125)', () => {
  test('ring rotation is replaced by a pulse under reducedMotion: reduce', async ({
    page,
    request,
  }, testInfo) => {
    // Assert against the production build (what ships, and the only project CI
    // runs). The vite-dev project re-optimizes dependencies on first load and
    // forces a full page reload mid-test, tearing down the transient spinner
    // before the computed-style read can settle — a dev-server artifact, not a
    // product behavior.
    test.skip(testInfo.project.name === 'dev', 'computed-style assertion targets the prod build');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await resetBackendState(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    // #244 replaced the inbox cold-load <Spinner> with a content-shaped skeleton,
    // so the remaining <Spinner> mount is the diff pane's "whole file" overlay.
    // Drive it via the hermetic acme/api/123 fixture (single small file → "Show
    // full file" is enabled) and hold the whole-file content fetch open so the
    // overlay <Spinner size="md"> stays mounted for the assertions.
    await page.route('**/api/pr/acme/api/123/file**', HANG_FOREVER);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    await page.getByTestId('diff-settings-trigger').click();
    await page.getByTestId('show-full-file-checkbox').check();

    // While the whole-file overlay is active the header spinner is suppressed, so
    // the overlay is the only role=status in the diff pane. Target the ring (the
    // aria-hidden child of the spinner's status region).
    const ring = page.locator('[data-testid="diff-pane"] [role="status"] [aria-hidden="true"]');
    await expect(ring).toBeVisible({ timeout: 10_000 });

    // Assert via animation-duration (hash-independent, unlike keyframe names
    // which CSS-modules hashes): rotation is 0.6s, the reduced-motion pulse is
    // 1.2s. Poll to ride out the diff-pane render settling.
    await expect
      .poll(
        async () => {
          try {
            return await ring.evaluate((el) => window.getComputedStyle(el).animationDuration);
          } catch {
            return null;
          }
        },
        { timeout: 10_000 },
      )
      .toBe('1.2s'); // the reduced-motion pulse, not the 0.6s rotation
  });
});
