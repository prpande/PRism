# First-run Welcome / Landing Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/welcome` first-run landing screen that orients a brand-new user (brand icon, wordmark, value tagline, three benefit rows, "Get started" CTA, Help/Send-feedback footer stubs) before the cold `/setup` token form — shown only on a true first run (`!hasToken`), with a first-run-only "← Back" on `/setup`.

**Architecture:** Pure frontend. A new `WelcomePage` component reuses the existing setup `.screen`/`.bg`/`.card` shell. `App.tsx` routes unauthed users to `/welcome` when `!authState.hasToken`, else `/setup`; re-auth (`hasToken` true) and Settings→Replace never see `/welcome`. No new state, no backend change, no new network call. Copy is placeholder (rewrite owned by #222); Help/Feedback links are stubs (wired by #210/#211).

**Tech Stack:** React + TypeScript + Vite, react-router-dom, CSS modules + `tokens.css`, Vitest + Testing Library + msw (unit), Playwright + @axe-core/playwright (e2e).

**Spec:** `docs/specs/2026-06-06-first-run-welcome-landing-design.md`

---

## File Structure

**Create:**
- `frontend/src/pages/WelcomePage.tsx` — the landing component (presentational; one `<Link>` to `/setup`, no data fetching).
- `frontend/src/pages/WelcomePage.module.css` — the welcome card styles (mirrors `SetupPage.module.css` shell + centered content).
- `frontend/__tests__/welcome-page.test.tsx` — `WelcomePage` unit tests.
- `frontend/e2e/welcome.spec.ts` — first-run `/welcome` e2e flow + axe check.

**Modify:**
- `frontend/src/App.tsx` — add the `/welcome` route + conditional unauthed redirect target across the four guards.
- `frontend/src/components/Setup/SetupForm.tsx` — add `showBackToWelcome?: boolean` prop, render the "← Back" link.
- `frontend/src/components/Setup/SetupForm.module.css` — add the `.back` link style.
- `frontend/src/pages/SetupPage.tsx` — compute `showBackToWelcome = !authState.hasToken` and pass it.
- `frontend/__tests__/app.test.tsx` — migrate the `routes to /setup when no token` case to `/welcome`; add the new routing cases.
- `frontend/__tests__/setup-form.test.tsx` — add back-link rendering tests.
- `frontend/e2e/cold-start.spec.ts` — migrate the two `goto('/')` first-run tests to expect `/welcome`.

**Verified unaffected (do not touch):**
- `frontend/e2e/sr-only-containment.spec.ts` — screen-agnostic (probes a throwaway `.sr-only`; explicitly "may land on Setup, Inbox, or a PR"). Landing on `/welcome` is fine.
- `frontend/e2e/setup-no-page-scroll.spec.ts`, `cold-start.spec.ts` tests 2 & 3 — navigate to `/setup` directly (unchanged route).
- All authed e2e specs (inbox/settings/submit/replace/a11y-audit/parity-baselines) — seed a token, so `!hasToken` routing never fires.

---

## Task 1: `WelcomePage` component + styles

**Files:**
- Create: `frontend/src/pages/WelcomePage.tsx`
- Create: `frontend/src/pages/WelcomePage.module.css`
- Test: `frontend/__tests__/welcome-page.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/welcome-page.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { WelcomePage } from '../src/pages/WelcomePage';

function renderWelcome() {
  return render(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
}

describe('WelcomePage', () => {
  it('renders the brand icon decoratively (empty alt)', () => {
    const { container } = renderWelcome();
    const img = container.querySelector('img[src="/prism-logo.png"]');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
  });

  it('renders the PRism wordmark as the h1', () => {
    renderWelcome();
    expect(screen.getByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
  });

  it('renders the tagline and three benefit rows', () => {
    renderWelcome();
    expect(
      screen.getByText(/review pull requests without leaving your machine/i),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('Get started links to /setup', () => {
    renderWelcome();
    const cta = screen.getByRole('link', { name: /get started/i });
    expect(cta).toHaveAttribute('href', '/setup');
  });

  it('renders Help and Send feedback as plain text stubs, not links', () => {
    renderWelcome();
    expect(screen.getByText('Help')).toBeInTheDocument();
    expect(screen.getByText('Send feedback')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^help$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /send feedback/i })).toBeNull();
    expect(screen.getByText('Help').tagName).toBe('SPAN');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run __tests__/welcome-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/pages/WelcomePage"`.

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/WelcomePage.tsx`:

```tsx
import { Link } from 'react-router-dom';
import styles from './WelcomePage.module.css';

// Placeholder copy (tagline + benefits) — the human rewrite is owned by #222.
// Keep it plain and honest, not faux-marketing. The leading emoji are decorative
// (aria-hidden); only the text is announced.
const BENEFITS: ReadonlyArray<{ emoji: string; text: string }> = [
  { emoji: '🔒', text: 'Local-first — your PAT never leaves this device.' },
  { emoji: '⚡', text: 'A focused PR-review workspace, not the GitHub web tab.' },
  { emoji: '🤖', text: 'AI hotspots surface the hunks worth a close look.' },
];

export function WelcomePage() {
  return (
    <div className={styles.screen}>
      <div className={styles.bg} aria-hidden="true" />
      <div className={styles.card} data-testid="welcome-card">
        {/* Decorative: the <h1> wordmark below already names the product, so a
            non-empty alt would make a screen reader announce "PRism" twice. */}
        <img src="/prism-logo.png" alt="" width={60} height={60} className={styles.logo} />
        {/* Keep the wordmark a BARE text node — welcome-page/app/e2e tests assert
            the h1's accessible name is exactly "PRism". A nested span or sibling
            text node would silently break the exact-name match across suites. */}
        <h1 className={styles.wordmark}>PRism</h1>
        <p className={styles.tagline}>Review pull requests without leaving your machine.</p>
        <ul className={styles.benefits}>
          {BENEFITS.map((b) => (
            <li key={b.text} className={styles.benefit}>
              <span className={styles.benefitEmoji} aria-hidden="true">
                {b.emoji}
              </span>
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
        <Link to="/setup" className={`${styles.cta} btn btn-primary btn-lg`}>
          Get started
        </Link>
        {/* Footer stubs — plain non-interactive text (NOT links). #210 wires Help,
            #211 wires Send feedback. A stub must not render or announce as a link. */}
        <div className={styles.footer}>
          <span className={styles.footerStub}>Help</span>
          <span className={styles.footerDivider} aria-hidden="true">
            ·
          </span>
          <span className={styles.footerStub}>Send feedback</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the styles**

Create `frontend/src/pages/WelcomePage.module.css` (the `.screen`/`.bg`/`.card` rules mirror `SetupPage.module.css` — duplicated deliberately so the two first-run screens can diverge; the `min-height: calc(100dvh - var(--header-h))` is the #205 no-page-scroll fix):

```css
.screen {
  position: relative;
  flex: 1;
  min-height: calc(100dvh - var(--header-h, 56px));
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: var(--s-6);
}
.bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(
      circle at 20% 0%,
      color-mix(in oklch, var(--accent) 8%, transparent),
      transparent 40%
    ),
    radial-gradient(
      circle at 90% 100%,
      color-mix(in oklch, var(--accent) 6%, transparent),
      transparent 40%
    );
  pointer-events: none;
}
.card {
  position: relative;
  width: 440px;
  max-width: 100%;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-4);
  padding: var(--s-8);
  box-shadow: var(--shadow-3);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.logo {
  display: block;
  margin-bottom: var(--s-3);
}
.wordmark {
  font-size: var(--text-2xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 var(--s-2);
}
.tagline {
  margin: 0 0 var(--s-6);
  color: var(--text-2);
  font-size: var(--text-md);
  line-height: 1.5;
}
.benefits {
  list-style: none;
  margin: 0 0 var(--s-6);
  padding: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  text-align: left;
}
.benefit {
  display: flex;
  gap: var(--s-3);
  align-items: flex-start;
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.45;
}
.benefitEmoji {
  flex: none;
}
/* The CTA is a <Link> styled as the primary button. Kill the global `a:hover`
   underline so it reads as a button, not an underlined link. */
.cta {
  width: 100%;
  text-decoration: none;
}
.cta:hover {
  text-decoration: none;
}
.footer {
  margin-top: var(--s-5);
  padding-top: var(--s-4);
  align-self: stretch;
  border-top: 1px solid var(--border-1);
  display: flex;
  justify-content: center;
  gap: var(--s-3);
  font-size: var(--text-xs);
  color: var(--text-3);
}
.footerDivider {
  color: var(--text-4);
}
/* The Help / Send-feedback stubs read as quiet "coming soon" labels, not links.
   They inherit the muted `.footer` color; `cursor: default` reinforces that they
   are not clickable. #210/#211 replace them with real links. */
.footerStub {
  cursor: default;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run __tests__/welcome-page.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git -C D:/src/PRism-212-welcome add frontend/src/pages/WelcomePage.tsx frontend/src/pages/WelcomePage.module.css frontend/__tests__/welcome-page.test.tsx
git -C D:/src/PRism-212-welcome commit -m "feat(#212): WelcomePage first-run landing component"
```

---

## Task 2: Wire the `/welcome` route + conditional unauthed redirect

**Files:**
- Modify: `frontend/src/App.tsx`
- Test: `frontend/__tests__/app.test.tsx`

- [ ] **Step 1: Migrate + extend the routing tests (write them first; they fail against current App)**

In `frontend/__tests__/app.test.tsx`, **replace** the existing `routes to /setup when no token` test (currently lines ~61-76) with the migrated + new cases below. Leave the other tests in the file unchanged except the one re-auth augmentation noted.

Replace this block:

```tsx
  it('routes to /setup when no token', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
    // #130: first-run hides the nav entirely.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();
  });
```

with:

```tsx
  it('routes to /welcome on first run (no token)', async () => {
    // #212: a true first-run user (!hasToken) lands on the welcome screen, NOT
    // the cold /setup token form.
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'PRism' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toBeInTheDocument();
    // Not the setup screen.
    expect(screen.queryByText(/connect to github/i)).toBeNull();
    // #130: first-run still hides the nav entirely.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: /inbox/i })).toBeNull();
  });

  it('reachable /setup directly while unauthed (not bounced to /welcome)', async () => {
    // #212: /setup stays directly reachable so a first-run user mid-typing is not
    // bounced. Navigating straight to /setup shows the token form.
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
  });

  it('authed user navigating to /welcome is redirected to / (Inbox)', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByPlaceholderText(/paste a pr url/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
  });
```

Then, in the existing test `hides the header nav when a token exists but auth is rejected, and restores it on recovery`, add one assertion right after the `findByText(/connect to github/i)` line (the re-auth user must land on `/setup`, **never** `/welcome`):

```tsx
    // #212: re-auth (token present, rejected) goes to /setup, never the welcome hero.
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run __tests__/app.test.tsx`
Expected: FAIL — the new `routes to /welcome on first run` and `authed → /welcome → /` cases fail because `/welcome` is not yet a route (the catch-all redirects it).

- [ ] **Step 3: Implement the routing change in `App.tsx`**

In `frontend/src/App.tsx`, add the import near the other page imports (after the `SetupPage` import on line ~10):

```tsx
import { WelcomePage } from './pages/WelcomePage';
```

Then, inside `App()`, just after the `const isAuthed = authState.hasToken && !authInvalidated;` line (~line 83), add:

```tsx
  // #212: unauthed users split by whether they've ever connected. A true first
  // run (!hasToken) gets the welcome screen; a token-rejected re-auth session
  // (hasToken true) goes straight to the /setup token form — never re-onboarded.
  const unauthedTarget = authState.hasToken ? '/setup' : '/welcome';
```

Then update the `<Routes>` block. Replace this current block (lines ~96-112):

```tsx
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route
              path="/settings"
              element={isAuthed ? <SettingsPage /> : <Navigate to="/setup" replace />}
            />
            <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
            {/* PR-detail views no longer live in the route table. The /pr route
                renders null; the persistent PrTabHost below renders one
                keep-alive PrDetailView per open tab and shows the one matching
                the current /pr path. This is what lets a PR view survive
                navigating away and back with its sub-tab + scroll state intact. */}
            <Route
              path="/pr/:owner/:repo/:number/*"
              element={isAuthed ? null : <Navigate to="/setup" replace />}
            />
            <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
          </Routes>
```

with:

```tsx
          <Routes>
            {/* #212: the welcome screen renders ONLY for a true first run
                (!hasToken). A token-bearing user who somehow lands here is sent
                onward — authed → Inbox, rejected-token re-auth → /setup. */}
            <Route
              path="/welcome"
              element={
                authState.hasToken ? (
                  <Navigate to={isAuthed ? '/' : '/setup'} replace />
                ) : (
                  <WelcomePage />
                )
              }
            />
            <Route path="/setup" element={<SetupPage />} />
            <Route
              path="/settings"
              element={isAuthed ? <SettingsPage /> : <Navigate to={unauthedTarget} replace />}
            />
            <Route
              path="/"
              element={isAuthed ? <InboxPage /> : <Navigate to={unauthedTarget} replace />}
            />
            {/* PR-detail views no longer live in the route table. The /pr route
                renders null; the persistent PrTabHost below renders one
                keep-alive PrDetailView per open tab and shows the one matching
                the current /pr path. This is what lets a PR view survive
                navigating away and back with its sub-tab + scroll state intact. */}
            <Route
              path="/pr/:owner/:repo/:number/*"
              element={isAuthed ? null : <Navigate to={unauthedTarget} replace />}
            />
            <Route path="*" element={<Navigate to={isAuthed ? '/' : unauthedTarget} replace />} />
          </Routes>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run __tests__/app.test.tsx`
Expected: PASS (all cases, including the migrated + 3 new ones).

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-212-welcome add frontend/src/App.tsx frontend/__tests__/app.test.tsx
git -C D:/src/PRism-212-welcome commit -m "feat(#212): route first-run users to /welcome; migrate app routing tests"
```

---

## Task 3: First-run-only "← Back" on `/setup`

**Files:**
- Modify: `frontend/src/components/Setup/SetupForm.tsx`
- Modify: `frontend/src/components/Setup/SetupForm.module.css`
- Modify: `frontend/src/pages/SetupPage.tsx`
- Test: `frontend/__tests__/setup-form.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add these to `frontend/__tests__/setup-form.test.tsx` inside the `describe('SetupForm', ...)` block:

```tsx
  it('does NOT render a Back-to-welcome link by default', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /back/i })).not.toBeInTheDocument();
  });

  it('renders a Back link to /welcome when showBackToWelcome is true', () => {
    render(
      <MemoryRouter>
        <SetupForm host="https://github.com" onSubmit={vi.fn()} showBackToWelcome />
      </MemoryRouter>,
    );
    const back = screen.getByRole('link', { name: /back/i });
    expect(back).toHaveAttribute('href', '/welcome');
  });
```

(`MemoryRouter` is already imported in this file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run __tests__/setup-form.test.tsx`
Expected: FAIL — the `showBackToWelcome` prop does not exist; no Back link rendered.

- [ ] **Step 3: Add the prop + Back link to `SetupForm.tsx`**

In `frontend/src/components/Setup/SetupForm.tsx`, add to the `Props` interface (after `isReplaceMode?: boolean;`):

```tsx
  // #212 — on a true first run (!hasToken), SetupPage passes this so the user can
  // return to the /welcome landing. Absent (not disabled) otherwise, so re-auth
  // and replace users see no phantom back-link. Kept as a boolean prop (mirroring
  // isReplaceMode) so SetupForm stays router-agnostic and unit-testable bare.
  showBackToWelcome?: boolean;
```

Update the function signature destructure:

```tsx
export function SetupForm({ host, onSubmit, error, busy, isReplaceMode, showBackToWelcome }: Props) {
```

Then render the Back link as the **first** child inside the `<form>`, immediately after the opening `<form ...>` tag and before the `<div className={styles.brand}>` block:

```tsx
      {showBackToWelcome && (
        <Link to="/welcome" className={styles.back}>
          ← Back
        </Link>
      )}
```

(`Link` is already imported in this file.)

- [ ] **Step 4: Add the `.back` style**

In `frontend/src/components/Setup/SetupForm.module.css`, add at the end of the file:

```css
/* #212 first-run "← Back" to the /welcome landing. Mirrors the muted `.cancel`
   link treatment but sits at the TOP of the card (above the brand heading). */
.back {
  align-self: flex-start;
  margin-bottom: var(--s-4);
  font-size: var(--text-sm);
  color: var(--text-2);
}
```

- [ ] **Step 5: Run the SetupForm tests to verify they pass**

Run: `cd frontend && npx vitest run __tests__/setup-form.test.tsx`
Expected: PASS (including the two new cases and all existing ones).

- [ ] **Step 6: Wire the gate in `SetupPage.tsx`**

In `frontend/src/pages/SetupPage.tsx`, pass the new prop in the `<SetupForm ... />` render (currently lines ~167-173). The gate is `!authState.hasToken` alone — `hasToken === true` already excludes both re-auth and replace:

```tsx
          <SetupForm
            host={authState.host}
            onSubmit={isReplaceMode ? onReplace : onConnect}
            error={error}
            busy={busy}
            isReplaceMode={isReplaceMode}
            showBackToWelcome={!authState.hasToken}
          />
```

- [ ] **Step 7: Add a SetupPage gate test**

In `frontend/__tests__/setup-page.test.tsx`, add a `/welcome` route to the `renderRouted` helper's `<Routes>` so the Back link has a destination, then add gate tests. Update the helper's Routes block:

```tsx
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/" element={<div>InboxMock</div>} />
          <Route path="/settings" element={<div>SettingsMock</div>} />
          <Route path="/welcome" element={<div>WelcomeMock</div>} />
        </Routes>
```

Then add these tests inside `describe('SetupPage', ...)` (the `beforeEach` already mocks `hasToken: false`, i.e. first run):

```tsx
  it('shows the first-run Back-to-welcome link when there is no token', async () => {
    renderRouted();
    const back = await screen.findByRole('link', { name: /back/i });
    expect(back).toHaveAttribute('href', '/welcome');
  });

  it('hides the Back-to-welcome link for a token-bearing (re-auth) session', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
      ),
    );
    renderRouted();
    await screen.findByLabelText(/personal access token/i);
    expect(screen.queryByRole('link', { name: /back/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 8: Run the SetupPage tests to verify they pass**

Run: `cd frontend && npx vitest run __tests__/setup-page.test.tsx`
Expected: PASS (including the two new gate tests; the existing replace-mode test still has no Back link because that session has a token).

- [ ] **Step 9: Commit**

```bash
git -C D:/src/PRism-212-welcome add frontend/src/components/Setup/SetupForm.tsx frontend/src/components/Setup/SetupForm.module.css frontend/src/pages/SetupPage.tsx frontend/__tests__/setup-form.test.tsx frontend/__tests__/setup-page.test.tsx
git -C D:/src/PRism-212-welcome commit -m "feat(#212): first-run-only Back-to-welcome link on /setup"
```

---

## Task 4: e2e — welcome flow + migrate cold-start

**Files:**
- Create: `frontend/e2e/welcome.spec.ts`
- Modify: `frontend/e2e/cold-start.spec.ts`

- [ ] **Step 1: Create `frontend/e2e/welcome.spec.ts`**

The e2e harness runs first-run by default (fresh `--dataDir`, no token), so `/` redirects to `/welcome` with no auth mocking needed.

```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// #212: the first-run welcome/landing screen. The e2e backend starts with no
// token (fresh dataDir), so a no-token user is a genuine first run.

test('first run lands on /welcome', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
});

test('Get started advances to /setup and Back returns to /welcome', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('link', { name: /get started/i }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: /connect to github/i })).toBeVisible();
  // First-run-only Back returns to the landing.
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page).toHaveURL(/\/welcome$/);
});

test('/welcome hides the top nav and keeps the logo (first run, #130)', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^inbox$/i })).toHaveCount(0);
  // The header logo (alt="PRism") is still present.
  await expect(page.getByAltText('PRism')).toBeVisible();
});

test('footer Help / Send feedback are non-interactive stubs', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByText('Help')).toBeVisible();
  await expect(page.getByText('Send feedback')).toBeVisible();
  await expect(page.getByRole('link', { name: /^help$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /send feedback/i })).toHaveCount(0);
});

test('/welcome has no serious or critical a11y violations', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking).toEqual([]);
});
```

- [ ] **Step 2: Migrate the two first-run `cold-start.spec.ts` tests**

In `frontend/e2e/cold-start.spec.ts`, the two tests that `goto('/')` now land on `/welcome`. Replace test 1 (`cold start lands on Setup screen when no token`, lines 3-12):

```ts
test('cold start lands on the /welcome landing when no token', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
});
```

And replace test 4 (`cold start hides the top nav tabs (#130)`, lines 32-44):

```ts
test('cold start hides the top nav tabs on /welcome (#130)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'PRism' })).toBeVisible({
    timeout: 30_000,
  });
  // First-run: the nav tab strip is not rendered at all.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^inbox$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveCount(0);
  // Logo still present.
  await expect(page.getByAltText('PRism')).toBeVisible();
});
```

Leave tests 2 and 3 (`Continue button is disabled`, `typing in PAT enables Continue`) unchanged — they `goto('/setup')` directly.

- [ ] **Step 3: Run the affected e2e specs**

Run (foreground, one at a time): `cd frontend && npx playwright test welcome.spec.ts cold-start.spec.ts`
Expected: PASS. All welcome cases green; cold-start 4 tests green.

> If your local environment cannot run Playwright (no browser binary), note that and rely on CI — but the pre-push checklist (Task 6) requires the suite to pass somewhere before push.

- [ ] **Step 4: Commit**

```bash
git -C D:/src/PRism-212-welcome add frontend/e2e/welcome.spec.ts frontend/e2e/cold-start.spec.ts
git -C D:/src/PRism-212-welcome commit -m "test(#212): e2e welcome flow + migrate first-run cold-start tests"
```

---

## Task 5: B1 visual proof (light + dark)

This is the human-eyeball gate artifact, not a committed baseline (committed `toMatchSnapshot` baselines are intentionally avoided here — copy churns when #222 lands, and cross-platform baselines are brittle). Capture screenshots to embed on the PR.

**Files:** none committed to `frontend/` (screenshots are PR-comment assets, hosted per the project's review-assets convention).

- [ ] **Step 1: Launch the app fresh-first-run**

Per `feedback_fresh_experience_temp_datadir`: launch with a temp `--dataDir` so the real PAT config is untouched and the app is a genuine first run. Use the project's run path (`run.ps1`) with a temp data dir, then open `http://localhost:5180/welcome`.

- [ ] **Step 2: Capture `/welcome` in light and dark**

Take a screenshot of the `/welcome` card in **light** theme and in **dark** theme (toggle via Settings is unavailable pre-auth — set the theme by launching with the system theme in each mode, or drive it with a one-off Playwright `page.emulateMedia({ colorScheme: 'dark' | 'light' })` against the running app). Confirm per the spec's B1 criteria: card centered on the accent backdrop; logo at hero size above the "PRism" wordmark; tagline + three benefit rows; "Get started" CTA; Help · Send-feedback footer (plain muted text, not links) under a divider; no *page* scroll; logo legible on the dark card.

- [ ] **Step 3: Stage the screenshots for the PR**

Host the two PNGs on a throwaway `review-assets/pr-<n>` branch and embed via raw URLs in the PR `## Proof` § Visual (per `feedback_visual_verification_screenshots_on_pr`). This is done during PR assembly (Task 7), not committed to the feature branch.

---

## Task 6: Docs + spec-coverage sweep

**Files:**
- Possibly modify: docs under `.ai/docs/` if a routes/architecture doc enumerates the route table.

- [ ] **Step 1: Scan documentation-maintenance map**

Read `.ai/docs/documentation-maintenance.md` and check whether adding a `/welcome` route requires a doc update (e.g., a route inventory or first-run flow doc). If a matching doc exists, update it in this branch (fold into the PR per CLAUDE.md). If none matches, note "no doc update required" for the PR `## Proof`.

- [ ] **Step 2: Confirm the spec's acceptance criteria are all covered**

Cross-check each spec acceptance-criteria checkbox against the tasks above. All map to a test (Tasks 1-4) except the B1 visual (Task 5). Record the mapping for the PR `## Proof § Acceptance criteria`.

---

## Task 7: Full pre-push checklist + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full local pre-push checklist** (per `.ai/docs/development-process.md`; do NOT skip lint/build)

Run each, foreground, one at a time:

```bash
cd frontend && npx vitest run
```
Expected: all suites green (welcome-page, app, setup-form, setup-page included).

```bash
cd frontend && node ./node_modules/prettier/bin/prettier.cjs --check .
```
Expected: "All matched files use Prettier code style!" (run prettier directly, NOT via rtk — see `feedback_rtk_masks_lint_output`). If it reports changes, run the `--write` form, re-stage, and re-check.

```bash
cd frontend && npm run lint
```
Expected: no eslint errors.

```bash
cd frontend && npm run build
```
Expected: clean Vite/tsc build.

```bash
cd frontend && npx playwright test welcome.spec.ts cold-start.spec.ts sr-only-containment.spec.ts
```
Expected: PASS (welcome + cold-start migrated, sr-only unaffected — runs as a no-regression check that the `/` redirect change didn't break the screen-agnostic probe).

- [ ] **Step 2: Sync main, then ship via pr-autopilot**

Per `feedback_sync_main_before_dod_push` and `feedback_use_pr_autopilot`: fetch origin & merge `origin/main` into `feature/212-welcome-landing`, re-run the checklist if main moved, then invoke `pr-autopilot`. The PR `## Proof` must include: Acceptance-criteria checklist (Task 6.2), Secrets scan (none — frontend-only, no credentials), Visual (Task 5 light+dark screenshots), and the ce-doc-review dispositions already recorded in the spec.

- [ ] **Step 3: B1 gate handoff**

#212 is **B1-gated**. After `pr-autopilot` reaches green-and-ready, **pause** and notify the assignee (@prpande) with the PR link + the light/dark `/welcome` screenshots for the visual assert. The human merges.

---

## Self-Review (completed during plan authoring)

**Spec coverage:** Every spec section maps to a task — Routing §1 → Task 2; WelcomePage §2 → Task 1; `/setup` Back §3 → Task 3; Accessibility → Tasks 1 (alt/emoji/stub assertions) + 4 (axe); Testing → Tasks 1-4; B1 visual → Task 5; deferrals (#222/#210/#211/#213) are out of scope by design and carried as stubs/placeholder copy.

**Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step shows the actual code. The only intentional "placeholder" is the spec-mandated draft *copy* (owned by #222), which is real, shippable text, not a plan gap.

**Type/name consistency:** Prop `showBackToWelcome` is defined in Task 3 Step 3 and consumed identically in SetupPage (Step 6) and tests (Steps 1, 7). `unauthedTarget` defined and used consistently in App.tsx (Task 2 Step 3). CSS module class names (`screen`/`bg`/`card`/`logo`/`wordmark`/`tagline`/`benefits`/`benefit`/`benefitEmoji`/`cta`/`footer`/`footerStub`/`footerDivider`, `.back`) match between `WelcomePage.tsx`/`WelcomePage.module.css` and `SetupForm.tsx`/`SetupForm.module.css`. The `/welcome` route string is consistent across App.tsx, WelcomePage CTA (→`/setup`), SetupForm Back (→`/welcome`), and all tests.
