# First-run nav + Setup-tab removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the header nav during first-run (and rejected-token re-auth), and remove the standalone "Setup" tab, so the authed nav is just Inbox + Settings.

**Architecture:** `App.tsx` already computes `isAuthed = hasToken && !authInvalidated`. Rename the `Header` prop `hasToken` → `isAuthed`, pass `isAuthed`, render the `<nav>` tab strip only when `isAuthed`, and delete the third Setup `<Link>` plus its `setupActive` / `· Setup` indicator. Re-running setup stays the existing Settings → Auth "Replace token" link. No routing changes.

**Tech Stack:** React + react-router-dom, TypeScript, Vite, Vitest + Testing Library + MSW (unit), Playwright (e2e).

**Spec:** `docs/specs/2026-06-05-first-run-nav-design.md`. Tier T2, Risk B1 (visual assert at the end).

---

## File structure

- **Modify** `frontend/src/components/Header/Header.tsx` — prop rename, conditional `<nav>`, remove Setup tab.
- **Modify** `frontend/src/App.tsx:75` — pass `isAuthed` instead of `hasToken`.
- **Rewrite** `frontend/__tests__/header.test.tsx` — migrate to new behavior (the existing suite hard-codes the Setup tab / `·` / `hasToken` and will go red).
- **Modify** `frontend/__tests__/app.test.tsx` — add the rejected-token (`authInvalidated`) nav-hidden + recovery case (the only place that branch is observable; `Header` sees one `isAuthed` bool).
- **Modify** `frontend/e2e/cold-start.spec.ts` — first-run shows zero nav tabs.
- **Modify** `frontend/e2e/replace-token-same-login.spec.ts` — authed nav = Inbox + Settings, no Setup tab.

Note: `Header` is imported only by `App.tsx`; only `header.test.tsx` asserts the Setup tab (verified via grep). No other consumers.

---

## Task 1: Migrate the Header unit suite (RED)

**Files:**
- Test: `frontend/__tests__/header.test.tsx` (full rewrite)

- [ ] **Step 1: Replace the whole file** with the new suite (renames the helper to pass `isAuthed`, drops every Setup-tab / `·`-indicator case, adds the nav-hidden case):

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { Header } from '../src/components/Header/Header';

const preferencesBody = {
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
    configPath: '/fake/config.json',
    logsPath: '/fake/logs',
  },
};

const server = setupServer(
  http.get('/api/preferences', () => HttpResponse.json(preferencesBody)),
  http.get('/api/auth/state', () =>
    HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderAt(path: string, isAuthed: boolean = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header isAuthed={isAuthed} />
    </MemoryRouter>,
  );
}

describe('Header', () => {
  it('renders logo + Inbox/Settings tabs (no Setup tab) when authed', () => {
    renderAt('/');
    expect(screen.getByAltText('PRism')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^settings$/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /setup/i })).toBeNull();
  });

  it('hides the whole nav (no landmark, no tab links) when not authed; keeps the logo', () => {
    renderAt('/setup', false);
    expect(screen.getByAltText('PRism')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^settings$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /setup/i })).toBeNull();
  });

  it('marks Inbox active on "/"', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^settings$/i })).not.toHaveAttribute('aria-current');
  });

  it('marks Settings active on "/settings"', () => {
    renderAt('/settings');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps Settings active on "/setup?replace=1" — Replace flow is a Settings affordance (authed)', () => {
    renderAt('/setup?replace=1', true);
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps Settings active on a nested settings route (/settings/<sub>)', () => {
    renderAt('/settings/profile');
    expect(screen.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // #119: the ⌘K search palette isn't built, so the disabled box stays hidden.
  it('does not render the disabled global-search box on the Inbox (#119)', () => {
    renderAt('/');
    expect(screen.queryByPlaceholderText(/jump to PR or file/i)).toBeNull();
    expect(screen.queryByLabelText(/global search/i)).toBeNull();
  });

  it('does not render the disabled global-search box off the Inbox either (#119)', () => {
    renderAt('/settings');
    expect(screen.queryByPlaceholderText(/jump to PR or file/i)).toBeNull();
    expect(screen.queryByLabelText(/global search/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the suite to confirm it fails** (Header still defines `hasToken`, still renders the Setup tab and the nav unconditionally):

Run: `cd frontend && npx vitest run __tests__/header.test.tsx`
Expected: FAIL — e.g. `renders logo + Inbox/Settings tabs (no Setup tab)` fails because a `setup` link is found; `hides the whole nav ... when not authed` fails because the nav still renders.

- [ ] **Step 3: Commit the red test**

```bash
git add frontend/__tests__/header.test.tsx
git commit -m "test(#130): migrate Header suite to nav-hidden + no-Setup-tab behavior (red)"
```

---

## Task 2: Add the App-level rejected-token nav-hidden case (RED)

**Files:**
- Test: `frontend/__tests__/app.test.tsx` (add one case + tighten the no-token case)

- [ ] **Step 1: Add a nav-hidden assertion to the existing no-token test.** In the `it('routes to /setup when no token', ...)` block, after the `connect to github` assertion, add:

```tsx
    // #130: first-run hides the nav entirely.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();
```

- [ ] **Step 2: Add a dedicated rejected-token case** (the `authInvalidated` branch is only observable at the App level — `Header` receives a single `isAuthed` bool). Add this `it(...)` inside `describe('App routing', ...)`:

```tsx
  it('hides the header nav when a token exists but auth is rejected, and restores it on recovery', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    // Authed: nav is visible.
    expect(await screen.findByRole('link', { name: /inbox/i })).toBeInTheDocument();

    // 401 mid-session → isAuthed=false → nav hidden, bounced to /setup.
    window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();

    // Recovery → nav restored.
    window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
    expect(await screen.findByRole('link', { name: /inbox/i })).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the App suite to confirm the new assertions fail** (App still passes `hasToken`, so the nav shows in the rejected state):

Run: `cd frontend && npx vitest run __tests__/app.test.tsx`
Expected: FAIL — the rejected-token case finds an Inbox link after rejection (nav not hidden); the no-token case finds a `navigation` landmark.

- [ ] **Step 4: Commit the red test**

```bash
git add frontend/__tests__/app.test.tsx
git commit -m "test(#130): App hides header nav on auth-rejected; first-run no nav (red)"
```

---

## Task 3: Implement Header + App call-site (GREEN)

**Files:**
- Modify: `frontend/src/components/Header/Header.tsx`
- Modify: `frontend/src/App.tsx:75`

- [ ] **Step 1: Replace `Header.tsx`** with the new implementation (prop `isAuthed`, conditional `<nav>`, no Setup tab):

```tsx
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Logo } from './Logo';
import { WindowControls } from './WindowControls';
import styles from './Header.module.css';

interface HeaderProps {
  // The gate is "authenticated and usable", not merely "has a token": a
  // rejected-token session (authInvalidated) still has a token but is bounced to
  // /setup, so its nav would only bounce. App computes
  // isAuthed = hasToken && !authInvalidated and passes it here (#130).
  isAuthed: boolean;
}

// Active-state (authed nav only — Inbox + Settings):
//   Inbox    → pathname === '/' || '/inbox'
//   Settings → pathname === '/settings' || (pathname === '/setup' && ?replace=…)
// Replace-token UX is a Settings affordance, so /setup?replace=1 keeps Settings
// active. There is no standalone Setup tab (#130): first-run hides the nav, and
// re-running setup lives in Settings → Auth ("Replace token").
//
// The global ⌘K search palette is not built yet (#119). Rather than ship a
// permanently-disabled box with a not-allowed cursor, the markup is kept but
// gated behind this flag so nothing dead renders. When the palette lands, ALL
// THREE of these are required — flipping the flag alone would just re-introduce
// the dead control #119 removed: (1) set this to true, (2) remove `disabled`,
// (3) wire the ⌘K handler. It renders only off the Inbox, where the central
// "Paste a PR URL…" box already covers the same need.
const SEARCH_PALETTE_ENABLED = false;

export function Header({ isAuthed }: HeaderProps) {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const isReplaceMode = searchParams.has('replace');

  const inboxActive = pathname === '/' || pathname === '/inbox' || pathname.startsWith('/inbox/');
  const settingsActive =
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    (pathname === '/setup' && isReplaceMode);

  const classFor = (active: boolean) => (active ? styles.tabActive : styles.tab);

  return (
    <header className={styles.header}>
      <Logo />
      {/* #130: the nav tab strip renders only when authed. During first-run and
          rejected-token re-auth the tabs would only bounce back to /setup, so the
          <nav> element is omitted entirely (an empty navigation landmark is an a11y
          smell). Logo + WindowControls remain in every state — hiding the desktop
          close button would trap the user. */}
      {isAuthed && (
        <nav className={styles.tabs}>
          <Link
            to="/"
            className={classFor(inboxActive)}
            aria-current={inboxActive ? 'page' : undefined}
          >
            Inbox
          </Link>
          <Link
            to="/settings"
            className={classFor(settingsActive)}
            aria-current={settingsActive ? 'page' : undefined}
          >
            Settings
          </Link>
        </nav>
      )}
      <div className={styles.spacer} />
      {SEARCH_PALETTE_ENABLED && !inboxActive && (
        <input
          className={styles.search}
          placeholder="Jump to PR or file… ⌘K"
          title="Search palette — v1.1"
          disabled
          aria-label="Global search (placeholder)"
        />
      )}
      {/* Desktop shell only — renders nothing in the browser. */}
      <WindowControls />
    </header>
  );
}
```

- [ ] **Step 2: Update the `App.tsx` call site.** Change line ~75 from:

```tsx
        <Header hasToken={authState.hasToken} />
```

to:

```tsx
        <Header isAuthed={isAuthed} />
```

(`isAuthed` is already in scope — `App.tsx:65` computes it before the `tree` is built.)

- [ ] **Step 3: Run both unit suites to confirm GREEN:**

Run: `cd frontend && npx vitest run __tests__/header.test.tsx __tests__/app.test.tsx`
Expected: PASS — all Header cases and the App rejected-token/no-token cases pass.

- [ ] **Step 4: Typecheck (the prop rename must have no dangling `hasToken` consumer):**

Run: `cd frontend && npx tsc -b`
Expected: no errors (Header is imported only by App; the call site is updated). This is the same typecheck `npm run build` runs (`tsc -b && vite build`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Header/Header.tsx frontend/src/App.tsx
git commit -m "feat(#130): hide header nav when not authed; remove standalone Setup tab"
```

---

## Task 4: e2e — first-run no-nav + authed no-Setup-tab

**Files:**
- Modify: `frontend/e2e/cold-start.spec.ts`
- Modify: `frontend/e2e/replace-token-same-login.spec.ts`

- [ ] **Step 1: Add a first-run "no nav tabs" test** to `cold-start.spec.ts` (the e2e backend starts token-less, so `/` lands on Setup):

```ts
test('cold start hides the top nav tabs (#130)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible({
    timeout: 30_000,
  });
  // First-run: the nav tab strip is not rendered at all.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^inbox$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^setup$/i })).toHaveCount(0);
  // Logo still present.
  await expect(page.getByAltText('PRism')).toBeVisible();
});
```

- [ ] **Step 2: Add an authed-nav assertion** to `replace-token-same-login.spec.ts` (it already mocks an authed session and lands on `/settings`). Immediately after the existing `await expect(page.getByRole('heading', { name: /^auth$/i, level: 2 })).toBeVisible(...)`, add:

```ts
  // #130: authed nav is Inbox + Settings only — the standalone Setup tab is gone.
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: /^inbox$/i })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^settings$/i })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^setup$/i })).toHaveCount(0);
```

- [ ] **Step 3: Run the two specs** (requires the dev server / Playwright projects configured per the repo; run if the local Playwright environment is available):

Run: `cd frontend && npx playwright test cold-start.spec.ts replace-token-same-login.spec.ts`
Expected: PASS. (If the local Playwright environment isn't set up, rely on CI — note it in the PR Proof.)

- [ ] **Step 4: Sanity-check the no-token a11y audit still passes** (it forces `hasToken:false` to audit the Setup screen; with the nav now hidden it must not expect a nav landmark):

Run: `cd frontend && npx playwright test a11y-audit.spec.ts`
Expected: PASS (no assertion there depends on a header nav on the no-token screen).

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/cold-start.spec.ts frontend/e2e/replace-token-same-login.spec.ts
git commit -m "test(#130): e2e — first-run hides nav; authed nav has no Setup tab"
```

---

## Task 5: Full local gate + B1 visual proof

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend unit suite** (catch any cross-file fallout from the prop rename):

Run: `cd frontend && npx vitest run`
Expected: PASS, no Header/App regressions.

- [ ] **Step 2: Lint + format check** (`npm run lint` includes `prettier --check`; per repo convention these gate CI):

Run: `cd frontend && npm run lint`
Expected: clean. If prettier flags the changed files, run `npx prettier --write` on them and re-commit.

- [ ] **Step 3: Production build** (the app must build):

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Capture B1 visual proof.** Launch a fresh first-run instance and the authed instance (non-destructive temp dataDir) and screenshot the three states for the PR:
  - First-run (`--dataDir <temp>` → `/setup`): no nav tabs, Logo left, WindowControls right, Connect card below.
  - Authed (`/`): nav = Inbox + Settings, no Setup tab.
  - Replace (`/setup?replace=1` authed): nav shown, Settings active, Setup form with Cancel → /settings.

```pwsh
# fresh first-run (real config untouched):
dotnet run --project PRism.Web --no-browser --dataDir "$env:TEMP\prism-130-proof"
# (build wwwroot once via run.ps1 or `npm ci && npm run build` first)
```

  Embed before/after screenshots on the PR per the B1 convention (throwaway review-assets branch + raw URLs).

- [ ] **Step 5: Final commit (if any prettier/build fixups landed)**

```bash
git add -A
git commit -m "chore(#130): lint/format fixups"
```

---

## Verification checklist (maps to spec acceptance criteria)

- [ ] First-run: nav tab strip not rendered (Logo + WindowControls remain) — Task 1 (`hides the whole nav ... when not authed`), Task 2 (no-token), Task 4 Step 1.
- [ ] Standalone Setup tab removed; authed nav = Inbox + Settings — Task 1 (`no Setup tab`), Task 4 Step 2.
- [ ] Re-running setup reachable via Settings → Auth "Replace token" — Task 4 (the replace spec still drives that link).
- [ ] After setup completion the app lands on Inbox (no-regress) — unchanged `SetupPage.tsx`; not separately re-tested (see spec Deferred).
- [ ] Rejected-token re-auth hides the nav and recovers — Task 2.
- [ ] B1 visual assert (first-run / authed / replace + loading & host-mismatch no-regress) — Task 5 Step 4.
