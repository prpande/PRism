# Help & Feedback Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app `/help` guide (#210) and an in-app feedback form that files a GitHub issue in the public `prpande/PRism-feedback` repo with a prefilled-link fallback (#211), as one coherent Help+Feedback area.

**Architecture:** Frontend-only Help page on an auth-agnostic `/help` route reached from a header `?` icon and the `/welcome` footer (PR1). Feedback dialog → new `POST /api/feedback` → `IFeedbackSubmitter` (`GitHubFeedbackSubmitter` in `PRism.GitHub`) that POSTs an issue to `api.github.com` with the user's PAT; on `CannotCreate`/first-run/non-github.com host the frontend opens an https-validated prefilled `issues/new` link via `window.prism.openExternal` (PR2).

**Tech Stack:** React 19 + Vite + TypeScript + react-router (frontend); .NET 10 minimal API + `IHttpClientFactory` (backend); vitest + @testing-library/react (FE tests); xUnit + FluentAssertions + `WebApplicationFactory` (BE tests); Playwright (e2e).

**Source spec:** `docs/specs/2026-06-06-help-feedback-surface-design.md`.

## Plan deviations from the spec (documented per behavioral guidelines)

1. **`IFeedbackSubmitter` interface is kept, in `PRism.Core`** (spec §6 round-2 said "no interface, internal class"). Rationale: the endpoint integration test substitutes the submitter via the repo's universal `services.RemoveAll<IInterface>(); services.AddSingleton(fake)` pattern (used for `IReviewSubmitter`, `IReviewEventBus`, `IActivePrCache`); a concrete dependency can't be substituted that way. Placed in `PRism.Core` for consistency with the four sibling capability interfaces (`IReviewAuth`/`IReviewSubmitter`/…), all of which live there — a conscious choice over `PRism.GitHub`-internal placement. The submitter's *own* unit test uses the constructor seam directly (no interface needed there); the interface earns its keep only at the endpoint layer.
2. **The api.github.com header block is inlined in the submitter** (spec §4.1 allowed "extracted helper, or inlined"). Inlining 4 header lines avoids refactoring `GitHubReviewService`'s private `SendGitHubAsync` on a B2 surface.
3. **The cross-tier slug guard is a per-suite pinned-literal assertion** (spec §4.5 allowed "duplicated literal + test, or codegen"). Honest scope, corrected after review: this **detects a single-side accidental edit** (one constant changed, its test left pinned → that suite reds). It does **not** catch a deliberate repo *rename* (both constants + both test literals updated in one commit stay green while the tiers could still diverge from each other). No C#/TS runtime cross-check exists without a shared artifact, which a PoC doesn't warrant. Labelled accordingly in Tasks 8/13.

---

## Amendment (2026-06-07): PR1 Help is a routed MODAL, not a page

After PR1's first cut shipped a full-page `/help`, owner review redirected it to a **routed modal** mirroring Settings (see the spec's matching amendment). PR1 below described Tasks 1–7 against a page; the as-built PR1 differs as follows (Tasks 8–18 / PR2 are unchanged):

- **Task 1 (HelpIcon)** — unchanged; the header `?` glyph still applies.
- **Tasks 2–3 (HelpPage + `/help` page route)** — superseded. Instead: `components/Help/HelpModal.tsx` (bespoke portal modal like `SettingsModal` — scrim, focus trap, Esc/scrim/✕ close, auth-aware focus-restore), `components/Help/HelpModalRoutes.tsx` (ungated analog of `SettingsModalRoutes`), `components/Help/HelpSectionIcons.tsx` (accent-tracking SVGs), and `HelpModal.module.css`. Content is the same five sections, now **collapsible accordion** items (first open) with accent-colored icons. `App.tsx`: removed the `/help` page route, made `backgroundLocation` synthesise an auth-aware background for `/help`, and mounted `<HelpModalRoutes>`. `useEffectiveLocation` treats `/help` like `/settings`.
- **Tasks 4–5 (header `?` + `/welcome` Help link)** — unchanged behavior, but both triggers now pass `state={{ backgroundLocation: location }}` so the modal opens over the current page.
- **Task 6 (e2e)** — asserts the dialog (modal) rather than a page; adds a first-run welcome-footer case.
- Adversarial review fixes folded in: conditional `aria-controls`, `useId` body ids, re-auth focus fallback (`setup-card`), the Settings link forwards the real background, and the `useEffectiveLocation` `/help` guard.

The page-oriented task bodies below are retained for history; the bullet list above is the source of truth for PR1's Help surface.

---

# PR1 — Help surface (#210)

> Frontend-only, B1 only. Independently shippable; its value does not depend on PR2. The `/welcome` `Send feedback` stub and the HelpPage feedback button are left for PR2.

### Task 1: HelpIcon component

**Files:**
- Create: `frontend/src/components/Header/HelpIcon.tsx`
- Test: `frontend/src/components/Header/HelpIcon.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HelpIcon } from './HelpIcon';

describe('HelpIcon', () => {
  it('renders a decorative svg (aria-hidden, currentColor)', () => {
    const { container } = render(<HelpIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg!.querySelector('[stroke="currentColor"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Header/HelpIcon.test.tsx`
Expected: FAIL — cannot resolve `./HelpIcon`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/Header/HelpIcon.tsx` (mirrors `diffIcons.tsx` `SVG_PROPS` + `currentColor`):

```tsx
const SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

export function HelpIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M6 6.2a2 2 0 0 1 3.9.6c0 1.3-1.9 1.6-1.9 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.6" r="0.8" fill="currentColor" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Header/HelpIcon.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/src/PRism-wt/210-211-help-feedback
git add frontend/src/components/Header/HelpIcon.tsx frontend/src/components/Header/HelpIcon.test.tsx
git commit -m "feat(#210): add HelpIcon glyph"
```

### Task 2: HelpPage (static guide)

**Files:**
- Create: `frontend/src/pages/HelpPage.tsx`
- Create: `frontend/src/pages/HelpPage.module.css`
- Test: `frontend/src/pages/HelpPage.test.tsx`

- [ ] **Step 0: Verify the real cheatsheet keybinding**

The guide names the shortcut. Confirm the actual binding before writing the copy:

Run: `cd frontend && git grep -nE "metaKey|ctrlKey|'k'|\"k\"" src/hooks/useCheatsheetShortcut.ts`
Use whatever modifier+key the hook actually registers in the copy (the plan assumes `⌘K`/`Ctrl+K` — correct only if the grep confirms it). If it differs, write the real binding.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { HelpPage } from './HelpPage';

function renderHelp() {
  return render(
    <MemoryRouter>
      <HelpPage />
    </MemoryRouter>,
  );
}

describe('HelpPage', () => {
  it('renders an h1 "Help" and the main landmark', () => {
    renderHelp();
    expect(screen.getByRole('heading', { level: 1, name: 'Help' })).toBeInTheDocument();
    expect(screen.getByTestId('help-page')).toBeInTheDocument();
  });

  it('has scannable h2 sections with stable ids', () => {
    renderHelp();
    for (const id of ['what-is-prism', 'core-workflow', 'surfaces', 'connect-token', 'shortcuts']) {
      // eslint-disable-next-line testing-library/no-node-access
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it('refers to a GitHub token, never Azure DevOps', () => {
    renderHelp();
    expect(screen.getByTestId('help-page').textContent).toMatch(/GitHub/);
    expect(screen.getByTestId('help-page').textContent).not.toMatch(/Azure DevOps/i);
  });

  it('links token guidance to the GitHub-connection settings', () => {
    renderHelp();
    expect(screen.getByRole('link', { name: /github connection/i })).toHaveAttribute(
      'href',
      '/settings/github-connection',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/HelpPage.test.tsx`
Expected: FAIL — cannot resolve `./HelpPage`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/pages/HelpPage.module.css`:

```css
.page {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--s-6) var(--s-4) var(--s-7);
  color: var(--text-1);
}
.title {
  font-size: var(--text-2xl);
  font-weight: 600;
  margin: 0 0 var(--s-2);
}
.lede {
  color: var(--text-2);
  margin: 0 0 var(--s-5);
}
.section {
  margin-bottom: var(--s-5);
}
.sectionHeading {
  font-size: var(--text-lg);
  font-weight: 600;
  margin: 0 0 var(--s-2);
}
.section p {
  color: var(--text-2);
  margin: 0 0 var(--s-2);
}
/* Page-scoped action so the trigger doesn't inherit an app-wide oversized
   primary button; left-aligned with the text column. (PR2 renders the button.) */
.feedbackAction {
  margin-top: var(--s-6);
}
```

Create `frontend/src/pages/HelpPage.tsx`. Copy is task-first, names the real in-app labels, no emoji in headings. (PR2 adds the `Send feedback` button + dialog; PR1 ships the guide alone.)

```tsx
import { Link } from 'react-router-dom';
import styles from './HelpPage.module.css';

export function HelpPage() {
  return (
    <main className={styles.page} data-testid="help-page" tabIndex={-1}>
      <h1 className={styles.title}>Help</h1>
      <p className={styles.lede}>
        PRism is a local-first workspace for reviewing pull requests without leaving your machine.
      </p>

      <section className={styles.section}>
        <h2 id="what-is-prism" className={styles.sectionHeading}>
          What PRism is
        </h2>
        <p>
          PRism connects to GitHub with your personal access token and gives you a focused review
          workspace. Your token and PR data stay on this device.
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="core-workflow" className={styles.sectionHeading}>
          The review loop
        </h2>
        <p>
          To review a PR: open it from the <strong>Inbox</strong>, read the change in the PR detail
          view, leave comments on the <strong>Files</strong> tab, then use <strong>Submit</strong>{' '}
          to send your review back to GitHub.
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="surfaces" className={styles.sectionHeading}>
          The main surfaces
        </h2>
        <p>
          The <strong>Inbox</strong> lists the PRs awaiting you. Opening one shows the PR detail with
          an <strong>Overview</strong> and a <strong>Files</strong> tab. The gear opens{' '}
          <strong>Settings</strong> (appearance, inbox, GitHub connection).
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="connect-token" className={styles.sectionHeading}>
          Connecting or replacing your token
        </h2>
        <p>
          When you need to connect or replace your GitHub token, open{' '}
          <Link to="/settings/github-connection">Settings → GitHub connection</Link>. PRism
          recommends a classic token; the connect screen explains which token type you need.
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="shortcuts" className={styles.sectionHeading}>
          Keyboard shortcuts
        </h2>
        <p>
          Press <kbd>⌘K</kbd> (or <kbd>Ctrl+K</kbd>) anywhere to open the keyboard-shortcut
          cheatsheet. {/* Step 0: replace with the verified binding if it differs. */}
        </p>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/HelpPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/HelpPage.tsx frontend/src/pages/HelpPage.module.css frontend/src/pages/HelpPage.test.tsx
git commit -m "feat(#210): add static /help guide page"
```

### Task 3: Register the `/help` route (auth-agnostic)

**Files:**
- Modify: `frontend/src/App.tsx` (route table)
- Test: `frontend/src/pages/HelpPage.route.test.tsx` (new)

> The authed `App` tree mounts `EventStreamProvider`, which calls `new EventSource('/api/events')` on mount. jsdom has no `EventSource`, and `PreferencesProvider`/`InboxPage` fire `apiClient` fetches. The route test must stub these or it throws. We stub `EventSource` and mock `apiClient` so the mount is clean.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/HelpPage.route.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = vi.hoisted(() => ({
  value: { hasToken: false, host: 'https://github.com' } as Record<string, unknown>,
}));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ authState: authState.value, error: null, refetch: vi.fn() }),
}));
// Neutralize network-touching dependencies the App tree mounts.
vi.mock('../api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
  ApiError: class extends Error {},
}));

import { App } from '../App';

class FakeEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage = null;
  onerror = null;
}

function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('/help route', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('renders the Help page for a first-run (no token) user', () => {
    authState.value = { hasToken: false, host: 'https://github.com' };
    renderAppAt('/help');
    expect(screen.getByTestId('help-page')).toBeInTheDocument();
  });

  it('renders the Help page for an authed user', () => {
    authState.value = { hasToken: true, host: 'https://github.com' };
    renderAppAt('/help');
    expect(screen.getByTestId('help-page')).toBeInTheDocument();
  });
});
```

> `App` contains `Routes` (not its own Router — `main.tsx` supplies `BrowserRouter`), so mounting it inside `MemoryRouter` is valid (verified). If the authed mount still errors on an unmocked dependency, mock that hook too (mirror `InboxPage.test.tsx`'s mock set).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/HelpPage.route.test.tsx`
Expected: FAIL — `/help` falls through to the `*` redirect; `help-page` absent.

- [ ] **Step 3: Add the route**

In `frontend/src/App.tsx`, import `HelpPage` and add the route **outside** the `isAuthed` gates, immediately after the `<Route path="/setup" .../>` line:

```tsx
import { HelpPage } from './pages/HelpPage';
```

```tsx
            {/* #210: Help is reachable in every auth state (first-run users
                need it most), so it sits outside the isAuthed gates like
                /welcome. No auth redirect. */}
            <Route path="/help" element={<HelpPage />} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/HelpPage.route.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/HelpPage.route.test.tsx
git commit -m "feat(#210): mount auth-agnostic /help route"
```

### Task 4: Header `?` icon → `/help` (authed, with active state)

**Files:**
- Modify: `frontend/src/components/Header/Header.tsx`
- Test: `frontend/src/components/Header/Header.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/Header/Header.test.tsx`:

```tsx
describe('Header help', () => {
  it('renders a Help link to /help when authed', () => {
    at('/');
    expect(screen.getByRole('link', { name: /help/i })).toHaveAttribute('href', '/help');
  });

  it('marks the Help link active on /help', () => {
    at('/help');
    expect(screen.getByRole('link', { name: /help/i })).toHaveAttribute('aria-current', 'page');
  });

  it('hides the Help link when not authed', () => {
    at('/', false);
    expect(screen.queryByRole('link', { name: /help/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Header/Header.test.tsx`
Expected: FAIL — no Help link.

- [ ] **Step 3: Add the `?` link**

In `frontend/src/components/Header/Header.tsx`, import the icon and add `helpActive`, render the link inside the existing `{isAuthed && (…)}` region, before the gear `<Link>`:

```tsx
import { HelpIcon } from './HelpIcon';
```

```tsx
  const helpActive = pathname === '/help';
```

```tsx
      {isAuthed && (
        <Link
          to="/help"
          className={helpActive ? `${styles.gear} ${styles.gearOn}` : styles.gear}
          aria-label="Help"
          aria-current={helpActive ? 'page' : undefined}
        >
          <HelpIcon />
        </Link>
      )}
```

Reuses the `.gear`/`.gearOn` classes — no new CSS.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Header/Header.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Header/Header.tsx frontend/src/components/Header/Header.test.tsx
git commit -m "feat(#210): add header ? link to /help with active state"
```

### Task 5: Wire the `/welcome` "Help" footer stub to a link

**Files:**
- Modify: `frontend/src/pages/WelcomePage.tsx`
- Modify: `frontend/src/pages/WelcomePage.module.css`
- Test: `frontend/src/pages/WelcomePage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/pages/WelcomePage.test.tsx` (wrap in `MemoryRouter` if not already):

```tsx
it('renders Help as a link to /help', () => {
  render(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/WelcomePage.test.tsx`
Expected: FAIL — `Help` is a `<span>`.

- [ ] **Step 3: Convert the Help stub to a link**

In `frontend/src/pages/WelcomePage.tsx`, change the Help stub (keep `Send feedback` a stub — PR2 wires it). Ensure `import { Link } from 'react-router-dom';`:

```tsx
        <div className={styles.footer}>
          <Link to="/help" className={styles.footerLink}>
            Help
          </Link>
          <span className={styles.footerDivider} aria-hidden="true">
            ·
          </span>
          <span className={styles.footerStub}>Send feedback</span>
        </div>
```

Add to `frontend/src/pages/WelcomePage.module.css`:

```css
.footerLink {
  color: var(--text-2);
  text-decoration: none;
}
.footerLink:hover,
.footerLink:focus-visible {
  color: var(--accent-hover);
  text-decoration: underline;
}
button.footerLink {
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/WelcomePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/WelcomePage.tsx frontend/src/pages/WelcomePage.module.css frontend/src/pages/WelcomePage.test.tsx
git commit -m "feat(#210): wire /welcome Help stub to /help"
```

### Task 6: Playwright e2e — `/help` reachability

**Files:**
- Create: `frontend/e2e/help.spec.ts`

- [ ] **Step 1: Write the e2e test**

```ts
import { test, expect } from '@playwright/test';

test.describe('Help page', () => {
  test('authed user reaches /help via the header ? icon', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Help' }).click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  });

  test('/help renders directly', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByTestId('help-page')).toBeVisible();
  });
});
```

> Mirror the project's e2e auth bootstrap (inspect a sibling spec in `frontend/e2e/` for how an authed session is seeded). If the suite has a first-run fixture, add a case asserting the `/welcome` `Help` link reaches `/help`.

- [ ] **Step 2: Run the e2e spec**

Run: `cd frontend && npx playwright test e2e/help.spec.ts`
Expected: PASS (after seeding the same auth state sibling specs use).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/help.spec.ts
git commit -m "test(#210): e2e for /help reachability"
```

### Task 7: PR1 pre-push checklist + open PR

- [ ] **Step 1: Full local gate** (per `.ai/docs/development-process.md`; run prettier directly, not via rtk):

```bash
cd D:/src/PRism-wt/210-211-help-feedback/frontend
node ./node_modules/prettier/bin/prettier.cjs --check .
npm run lint
npm run build
npx vitest run
```
Expected: all green.

- [ ] **Step 2: Sync main, then ship via pr-autopilot**

Fetch + merge `origin/main`, then use `pr-autopilot`. PR body includes `## Proof` (non-bug work: tests authored test-first + AC checklist + secrets scan). **B1-gated** — drive to green-and-ready, then pause for the human visual assert (screenshots of `/help` on the PR).

---

# PR2 — Feedback pipeline (#211)

> Carries the B2 risk surface (GitHub write with the user's PAT). Branch from main **after PR1 merges** (or stack — decide at execution).

### Task 8: Backend feedback-repo constant + pinned-literal guard

**Files:**
- Create: `PRism.GitHub/Feedback/FeedbackRepo.cs`
- Test: `tests/PRism.GitHub.Tests/Feedback/FeedbackRepoTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using FluentAssertions;
using PRism.GitHub.Feedback;
using Xunit;

namespace PRism.GitHub.Tests.Feedback;

public class FeedbackRepoTests
{
    // Single-side-edit guard (plan deviation #3): pins this tier's literal.
    // The frontend pins the same value in feedbackRepo.test.ts. NOTE: this does
    // NOT catch a deliberate rename (both sides updated together stay green) —
    // it catches an accidental one-sided change to this constant.
    [Fact]
    public void Slug_is_the_public_feedback_repo()
    {
        FeedbackRepo.Owner.Should().Be("prpande");
        FeedbackRepo.Name.Should().Be("PRism-feedback");
        FeedbackRepo.Slug.Should().Be("prpande/PRism-feedback");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FeedbackRepoTests`
Expected: FAIL — `FeedbackRepo` not found.

- [ ] **Step 3: Implement**

```csharp
namespace PRism.GitHub.Feedback;

// The public feedback repo (#211). Compile-time constant — not user-configurable,
// not in state.json. Mirrored by the frontend FEEDBACK_REPO_SLUG.
public static class FeedbackRepo
{
    public const string Owner = "prpande";
    public const string Name = "PRism-feedback";
    public const string Slug = Owner + "/" + Name;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FeedbackRepoTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Feedback/FeedbackRepo.cs tests/PRism.GitHub.Tests/Feedback/FeedbackRepoTests.cs
git commit -m "feat(#211): add backend feedback-repo constant"
```

### Task 9: `IFeedbackSubmitter` interface + content/result types

**Files:**
- Create: `PRism.Core/Feedback/IFeedbackSubmitter.cs`
- Test: `tests/PRism.Core.Tests/Feedback/FeedbackTypesTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using FluentAssertions;
using PRism.Core.Feedback;
using Xunit;

namespace PRism.Core.Tests.Feedback;

public class FeedbackTypesTests
{
    [Fact]
    public void FeedbackContent_carries_the_allowlisted_fields_including_timestamp()
    {
        var ts = DateTimeOffset.Parse("2026-06-06T12:00:00Z");
        var c = new FeedbackContent("Bug", "Summary", "Details", "/pr/:owner/:repo/:number", "desktop", "0.2.0", ts);
        c.Category.Should().Be("Bug");
        c.RoutePattern.Should().Be("/pr/:owner/:repo/:number");
        c.Version.Should().Be("0.2.0");
        c.SubmittedAt.Should().Be(ts);
    }

    [Fact]
    public void FeedbackCreateResult_distinguishes_created_from_cannot_create()
    {
        FeedbackCreateResult.Created(12, "https://github.com/prpande/PRism-feedback/issues/12")
            .Should().Match<FeedbackCreateResult>(r => r.Outcome == FeedbackOutcome.Created && r.IssueNumber == 12);
        FeedbackCreateResult.CannotCreate().Outcome.Should().Be(FeedbackOutcome.CannotCreate);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter FeedbackTypesTests`
Expected: FAIL — types not found.

- [ ] **Step 3: Implement**

```csharp
namespace PRism.Core.Feedback;

// Allowlisted feedback fields (spec §4.2). Category/Summary/Details are user input;
// RoutePattern/Platform are machine context; Version + SubmittedAt are stamped by
// the endpoint (not trusted from the client).
public sealed record FeedbackContent(
    string Category,
    string Summary,
    string Details,
    string RoutePattern,
    string Platform,
    string Version,
    DateTimeOffset SubmittedAt);

public enum FeedbackOutcome
{
    Created,
    // GitHub returned 401/403/404/422 — the user's token can't create the issue.
    // The frontend falls back to the prefilled issues/new link.
    CannotCreate,
}

public sealed record FeedbackCreateResult(FeedbackOutcome Outcome, int? IssueNumber, string? HtmlUrl)
{
    public static FeedbackCreateResult Created(int issueNumber, string htmlUrl) =>
        new(FeedbackOutcome.Created, issueNumber, htmlUrl);

    public static FeedbackCreateResult CannotCreate() =>
        new(FeedbackOutcome.CannotCreate, null, null);
}

// Single-method seam. Kept as an interface (plan deviation #1) so endpoint tests
// substitute a fake via services.RemoveAll/AddSingleton — the repo's pattern for
// GitHub-touching services (cf. IReviewAuth/IReviewSubmitter, also in PRism.Core).
public interface IFeedbackSubmitter
{
    // Created on 201; CannotCreate on 401/403/404/422; throws HttpRequestException
    // on genuine transport/5xx so the endpoint maps it to 500.
    Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter FeedbackTypesTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Feedback/IFeedbackSubmitter.cs tests/PRism.Core.Tests/Feedback/FeedbackTypesTests.cs
git commit -m "feat(#211): add IFeedbackSubmitter interface + content/result types"
```

### Task 10: `GitHubFeedbackSubmitter` + `github.com` named client

**Files:**
- Create: `PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.GitHub.Tests/Feedback/GitHubFeedbackSubmitterTests.cs`

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Net;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Feedback;
using PRism.GitHub.Feedback;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Feedback;

public class GitHubFeedbackSubmitterTests
{
    private static readonly FeedbackContent Content =
        new("Bug", "It broke", "Steps: do X", "/pr/:owner/:repo/:number", "desktop", "0.2.0",
            DateTimeOffset.Parse("2026-06-06T12:00:00Z"));

    private static GitHubFeedbackSubmitter NewSubmitter(HttpMessageHandler handler, string host = "https://github.com") =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("ghp_test"), host);

    [Fact]
    public async Task Posts_to_api_github_com_issues_with_title_body_and_context()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created,
            """{"number":12,"html_url":"https://github.com/prpande/PRism-feedback/issues/12"}""");
        var sut = NewSubmitter(handler);

        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);

        handler.RequestMethods[0].Should().Be(HttpMethod.Post);
        handler.RequestPaths[0].Should().Be("/repos/prpande/PRism-feedback/issues");
        using var doc = JsonDocument.Parse(handler.RequestBodies[0]!);
        doc.RootElement.GetProperty("title").GetString().Should().StartWith("[Bug] It broke");
        var body = doc.RootElement.GetProperty("body").GetString()!;
        body.Should().Contain("Steps: do X");
        body.Should().Contain("route: /pr/:owner/:repo/:number");
        body.Should().Contain("version: 0.2.0");
        body.Should().Contain("submitted: 2026-06-06T12:00:00");
        doc.RootElement.TryGetProperty("labels", out _).Should().BeFalse(); // labels omitted (D3)
        result.Outcome.Should().Be(FeedbackOutcome.Created);
        result.IssueNumber.Should().Be(12);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.UnprocessableEntity)]
    public async Task Maps_401_403_404_422_to_CannotCreate(HttpStatusCode status)
    {
        var sut = NewSubmitter(new RecordingHttpMessageHandler(status, """{"message":"no"}"""));
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
    }

    [Fact]
    public async Task Throws_on_5xx()
    {
        var sut = NewSubmitter(new RecordingHttpMessageHandler(HttpStatusCode.InternalServerError, "boom"));
        var act = () => sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        await act.Should().ThrowAsync<HttpRequestException>();
    }

    [Fact]
    public async Task Drops_non_https_html_url_defensively()
    {
        var sut = NewSubmitter(new RecordingHttpMessageHandler(
            HttpStatusCode.Created, """{"number":5,"html_url":"javascript:alert(1)"}"""));
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.HtmlUrl.Should().BeEmpty(); // frontend will hide the Open-in-GitHub link
    }

    [Fact]
    public async Task Non_github_com_host_short_circuits_without_calling_github()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, "{}");
        var sut = NewSubmitter(handler, host: "https://ghe.corp.example");
        var result = await sut.CreateFeedbackIssueAsync(Content, CancellationToken.None);
        result.Outcome.Should().Be(FeedbackOutcome.CannotCreate);
        handler.RequestCount.Should().Be(0); // PAT never sent to api.github.com
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubFeedbackSubmitterTests`
Expected: FAIL — `GitHubFeedbackSubmitter` not found.

- [ ] **Step 3: Implement the submitter**

```csharp
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PRism.Core.Feedback;

namespace PRism.GitHub.Feedback;

// Creates a feedback issue in the public prpande/PRism-feedback repo using the
// user's PAT. Targets api.github.com via its own named client (NOT the host-scoped
// "github" client) — the feedback repo lives on github.com unconditionally (§4.1).
// Headers inlined (plan deviation #2). No logging of PAT or GitHub bodies (Octokit
// source-hygiene): error bodies are not read on the CannotCreate path.
public sealed class GitHubFeedbackSubmitter : IFeedbackSubmitter
{
    public const string ClientName = "github.com";

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _configuredHost;

    public GitHubFeedbackSubmitter(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string configuredHost)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _configuredHost = configuredHost;
    }

    // The configured GitHub host normalizes to github.com (case-insensitive,
    // trailing slash ignored) — mirrors HostUrlResolver's own github.com test.
    private static bool IsGitHubCom(string host) =>
        Uri.TryCreate(host, UriKind.Absolute, out var u)
        && u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase);

    public async Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);

        // Defense-in-depth (not just the frontend gate): never read or egress the
        // user's PAT to public api.github.com when they're on a GHES host. The
        // feedback repo lives on github.com only, so a non-github.com session
        // short-circuits to CannotCreate → the frontend opens the prefilled link.
        if (!IsGitHubCom(_configuredHost))
            return FeedbackCreateResult.CannotCreate();

        var title = $"[{content.Category}] {content.Summary}";
        var body = BuildBody(content);
        var payload = JsonSerializer.Serialize(new { title, body });

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient(ClientName);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"repos/{FeedbackRepo.Slug}/issues")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);

        // 401 (expired/revoked PAT), 403 (scope/permission/rate-limit), 404
        // (fine-grained can't see repo), 422 (validation/missing-label) all degrade
        // to the prefilled-link fallback rather than a retry-forever 5xx.
        if (resp.StatusCode is HttpStatusCode.Unauthorized
            or HttpStatusCode.Forbidden
            or HttpStatusCode.NotFound
            or HttpStatusCode.UnprocessableEntity)
            return FeedbackCreateResult.CannotCreate();

        resp.EnsureSuccessStatusCode(); // genuine transport/5xx → throw → endpoint 500

        var responseBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;
        var number = root.TryGetProperty("number", out var n) && n.ValueKind == JsonValueKind.Number ? n.GetInt32() : 0;
        var htmlUrl = root.TryGetProperty("html_url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "";
        // Defense-in-depth: never propagate a non-https html_url to the client
        // (the frontend openExternal also guards, but don't rely on a single layer).
        if (!htmlUrl.StartsWith("https://", StringComparison.Ordinal)) htmlUrl = "";
        return FeedbackCreateResult.Created(number, htmlUrl);
    }

    private static string BuildBody(FeedbackContent c)
    {
        var sb = new StringBuilder();
        sb.AppendLine(c.Details);
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine("```");
        sb.AppendLine($"route: {c.RoutePattern}");
        sb.AppendLine($"platform: {c.Platform}");
        sb.AppendLine($"version: {c.Version}");
        sb.AppendLine($"submitted: {c.SubmittedAt:O}");
        sb.AppendLine("```");
        return sb.ToString();
    }
}
```

- [ ] **Step 4: Register the client + the submitter in DI**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, after the existing `services.AddHttpClient("github", …)` block:

```csharp
        // Feedback always targets github.com (the feedback repo lives there),
        // independent of the user's configured host (§4.1).
        services.AddHttpClient(PRism.GitHub.Feedback.GitHubFeedbackSubmitter.ClientName, client =>
        {
            client.BaseAddress = new Uri("https://api.github.com/");
        });

        services.AddSingleton<PRism.Core.Feedback.IFeedbackSubmitter>(sp =>
        {
            var config = sp.GetRequiredService<IConfigStore>();
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            // Capture the configured host the same way GitHubReviewService does
            // (early-bound). The submitter short-circuits to CannotCreate for any
            // non-github.com host so a GHES PAT is never sent to api.github.com.
            return new PRism.GitHub.Feedback.GitHubFeedbackSubmitter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                config.Current.Github.Host);
        });
```

(Add `using` for the namespaces if the file uses usings rather than fully-qualified names.)

- [ ] **Step 5: Run to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubFeedbackSubmitterTests`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/Feedback/GitHubFeedbackSubmitterTests.cs
git commit -m "feat(#211): GitHubFeedbackSubmitter posts issue to api.github.com"
```

### Task 11: Wire a real build version

**Files:**
- Modify: `PRism.Web/PRism.Web.csproj`
- Create: `PRism.Web/Endpoints/AppVersion.cs`
- Test: `tests/PRism.Web.Tests/AppVersionTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using FluentAssertions;
using PRism.Web.Endpoints;
using Xunit;

namespace PRism.Web.Tests;

public class AppVersionTests
{
    [Fact]
    public void Current_starts_with_the_csproj_informational_version()
    {
        // Pins that the <InformationalVersion> propagates; tolerates the SDK's
        // optional +<git-sha> suffix.
        AppVersion.Current.Should().StartWith("0.2.0");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter AppVersionTests`
Expected: FAIL — `AppVersion` not found / version defaults to `1.0.0.0`.

- [ ] **Step 3: Set the version + add the helper**

In `PRism.Web/PRism.Web.csproj`, inside the first `<PropertyGroup>` (match desktop's `0.2.0`):

```xml
    <InformationalVersion>0.2.0</InformationalVersion>
```

Create `PRism.Web/Endpoints/AppVersion.cs`:

```csharp
using System.Reflection;

namespace PRism.Web.Endpoints;

// Authoritative build version for the feedback context (§4.2). Reads the
// InformationalVersion set in PRism.Web.csproj. SDK may append "+<git-sha>".
internal static class AppVersion
{
    public static string Current { get; } =
        typeof(AppVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(AppVersion).Assembly.GetName().Version?.ToString()
        ?? "unknown";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter AppVersionTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/PRism.Web.csproj PRism.Web/Endpoints/AppVersion.cs tests/PRism.Web.Tests/AppVersionTests.cs
git commit -m "feat(#211): wire real build version for feedback context"
```

### Task 12: `POST /api/feedback` endpoint

**Files:**
- Create: `PRism.Web/Endpoints/FeedbackDtos.cs`
- Create: `PRism.Web/Endpoints/FeedbackEndpoints.cs`
- Modify: `PRism.Web/Program.cs` (registration list)
- Test: `tests/PRism.Web.Tests/Endpoints/FeedbackEndpointTests.cs`

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Feedback;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class FeedbackEndpointTests
{
    private sealed class FakeFeedbackSubmitter : IFeedbackSubmitter
    {
        public FeedbackContent? Last { get; private set; }
        public FeedbackCreateResult Result { get; set; } = FeedbackCreateResult.Created(7, "https://x/7");
        public bool Throw { get; set; }
        public Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
        {
            Last = content;
            if (Throw) throw new HttpRequestException("boom", null, HttpStatusCode.InternalServerError);
            return Task.FromResult(Result);
        }
    }

    private static (WebApplicationFactory<Program> f, FakeFeedbackSubmitter sub) NewApp()
    {
        var sub = new FakeFeedbackSubmitter();
        var f = new PRismWebApplicationFactory().WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IFeedbackSubmitter>();
            s.AddSingleton<IFeedbackSubmitter>(sub);
        }));
        return (f, sub);
    }

    private static object ValidBody() =>
        new { category = "Bug", summary = "It broke", details = "Steps", routePattern = "/inbox", platform = "browser" };

    [Fact]
    public async Task Created_returns_201_with_issue_number_and_stamps_version_and_timestamp()
    {
        var (f, sub) = NewApp();
        sub.Result = FeedbackCreateResult.Created(42, "https://github.com/prpande/PRism-feedback/issues/42");
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<FeedbackResponseDto>();
        dto!.IssueNumber.Should().Be(42);
        sub.Last!.Category.Should().Be("Bug");
        sub.Last!.Version.Should().StartWith("0.2.0");          // stamped server-side
        sub.Last!.SubmittedAt.Should().BeAfter(DateTimeOffset.MinValue); // stamped server-side
    }

    [Fact]
    public async Task CannotCreate_returns_422()
    {
        var (f, sub) = NewApp();
        sub.Result = FeedbackCreateResult.CannotCreate();
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Submitter_throw_surfaces_as_500()
    {
        var (f, sub) = NewApp();
        sub.Throw = true;
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
    }

    [Theory]
    [InlineData("Bug", "  ", "x", "/", "browser")]                                  // blank summary
    [InlineData("Banana", "ok", "x", "/", "browser")]                              // bad category
    public async Task Invalid_input_returns_400(string cat, string sum, string det, string route, string plat)
    {
        var (f, _) = NewApp();
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback",
            new { category = cat, summary = sum, details = det, routePattern = route, platform = plat });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Oversize_fields_return_400()
    {
        var (f, _) = NewApp();
        using var client = f.CreateClient();
        foreach (var body in new[]
        {
            new { category = "Bug", summary = new string('x', 121), details = "d", routePattern = "/", platform = "b" },
            new { category = "Bug", summary = "ok", details = new string('x', 4001), routePattern = "/", platform = "b" },
            new { category = "Bug", summary = "ok", details = "d", routePattern = new string('x', 257), platform = "b" },
            new { category = "Bug", summary = "ok", details = "d", routePattern = "/", platform = new string('x', 129) },
        })
        {
            var resp = await client.PostAsJsonAsync("/api/feedback", body);
            resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter FeedbackEndpointTests`
Expected: FAIL — endpoint + `FeedbackResponseDto` not found.

- [ ] **Step 3: Implement DTOs**

Create `PRism.Web/Endpoints/FeedbackDtos.cs`:

```csharp
namespace PRism.Web.Endpoints;

internal sealed record FeedbackRequestDto(
    string? Category,
    string? Summary,
    string? Details,
    string? RoutePattern,
    string? Platform);

internal sealed record FeedbackResponseDto(int IssueNumber, string HtmlUrl);

internal sealed record FeedbackErrorDto(string Error);
```

- [ ] **Step 4: Implement the endpoint**

Create `PRism.Web/Endpoints/FeedbackEndpoints.cs`:

```csharp
using Microsoft.AspNetCore.Http;
using PRism.Core.Feedback;

namespace PRism.Web.Endpoints;

internal static class FeedbackEndpoints
{
    private const int MaxSummary = 120;
    private const int MaxDetails = 4000;
    private const int MaxRoutePattern = 256;
    private const int MaxPlatform = 128;
    private static readonly string[] Categories = ["Bug", "Idea", "Other"];

    public static IEndpointRouteBuilder MapFeedback(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/feedback", SubmitAsync);
        return app;
    }

    private static async Task<IResult> SubmitAsync(
        FeedbackRequestDto? request,
        IFeedbackSubmitter submitter,
        CancellationToken ct)
    {
        if (request is null
            || string.IsNullOrWhiteSpace(request.Category)
            || string.IsNullOrWhiteSpace(request.Summary)
            || string.IsNullOrWhiteSpace(request.Details))
            return Results.BadRequest(new FeedbackErrorDto("missing-required-fields"));

        if (!Categories.Contains(request.Category))
            return Results.BadRequest(new FeedbackErrorDto("invalid-category"));

        if (request.Summary!.Length > MaxSummary
            || request.Details!.Length > MaxDetails
            || (request.RoutePattern?.Length ?? 0) > MaxRoutePattern
            || (request.Platform?.Length ?? 0) > MaxPlatform)
            return Results.BadRequest(new FeedbackErrorDto("field-too-long"));

        // Version + timestamp are stamped server-side (not trusted from the client).
        // RoutePattern/Platform pass through as the allowlisted machine context, with
        // line endings stripped so a client can't inject extra context lines (e.g.
        // "/inbox\nversion: 9.9.9") into the fenced block. No arbitrary client object
        // is forwarded into the issue body.
        var content = new FeedbackContent(
            request.Category!,
            request.Summary!.Trim(),
            request.Details!.Trim(),
            (request.RoutePattern ?? "unknown").ReplaceLineEndings(" "),
            (request.Platform ?? "unknown").ReplaceLineEndings(" "),
            AppVersion.Current,
            DateTimeOffset.UtcNow);

        var result = await submitter.CreateFeedbackIssueAsync(content, ct).ConfigureAwait(false);
        return result.Outcome == FeedbackOutcome.Created
            ? Results.Created(result.HtmlUrl ?? string.Empty, new FeedbackResponseDto(result.IssueNumber!.Value, result.HtmlUrl ?? string.Empty))
            : Results.Json(new FeedbackErrorDto("cannot-create"), statusCode: StatusCodes.Status422UnprocessableEntity);
    }
}
```

> Timestamp uses `DateTimeOffset.UtcNow` inline (no `TimeProvider` injection — it is **not** registered in this app's DI, and no test asserts an exact time; the endpoint test only checks `SubmittedAt > MinValue`, which `UtcNow` satisfies). A thrown `HttpRequestException` from the submitter is **not** caught here — `Program.cs`'s `app.UseExceptionHandler()` (verified at line ~202) turns it into a 500, matching the spec's "transport/5xx → 500 → frontend retry" contract (asserted by `Submitter_throw_surfaces_as_500`).

- [ ] **Step 5: Register in Program.cs**

In `PRism.Web/Program.cs`, add to the `app.Map…()` block:

```csharp
app.MapFeedback();
```

- [ ] **Step 6: Run to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter FeedbackEndpointTests`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Endpoints/FeedbackDtos.cs PRism.Web/Endpoints/FeedbackEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/FeedbackEndpointTests.cs
git commit -m "feat(#211): add POST /api/feedback endpoint"
```

### Task 13: Frontend feedback-repo constant + prefilled-link builder

**Files:**
- Create: `frontend/src/feedback/feedbackRepo.ts`
- Test: `frontend/src/feedback/feedbackRepo.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { FEEDBACK_REPO_SLUG, buildFeedbackIssueUrl } from './feedbackRepo';

describe('feedbackRepo', () => {
  it('pins the public feedback repo slug (single-side-edit guard; matches backend FeedbackRepo.Slug)', () => {
    expect(FEEDBACK_REPO_SLUG).toBe('prpande/PRism-feedback');
  });

  it('builds an https issues/new URL with encoded title and body', () => {
    const url = buildFeedbackIssueUrl({ title: '[Bug] a b', details: 'line1\nline2', context: 'route: /inbox' });
    const u = new URL(url);
    expect(u.protocol).toBe('https:');
    expect(u.host).toBe('github.com');
    expect(u.pathname).toBe('/prpande/PRism-feedback/issues/new');
    expect(u.searchParams.get('title')).toBe('[Bug] a b');
    expect(u.searchParams.get('body')).toContain('line1\nline2');
    expect(u.searchParams.get('body')).toContain('route: /inbox');
  });

  it('drops the context block first when over the cap, preserving details', () => {
    const details = 'D'.repeat(3000);
    const url = buildFeedbackIssueUrl({ title: 'x', details, context: 'C'.repeat(5000) });
    const body = new URL(url).searchParams.get('body')!;
    expect(url.length).toBeLessThanOrEqual(6144);
    expect(body).toContain('D'.repeat(2000)); // details substantially preserved
    expect(body).not.toContain('C'.repeat(100)); // context dropped
  });

  it('truncates details with a marker only when details alone still exceed the cap', () => {
    const url = buildFeedbackIssueUrl({ title: 'x', details: 'y'.repeat(10000), context: '' });
    expect(url.length).toBeLessThanOrEqual(6144);
    expect(new URL(url).searchParams.get('body')).toContain('(truncated');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/feedback/feedbackRepo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (two-stage truncation, Context-first — no binary search)**

```ts
// The public feedback repo (#211). Pinned literal — mirrors backend FeedbackRepo.Slug.
export const FEEDBACK_REPO_SLUG = 'prpande/PRism-feedback';

const MAX_URL = 6144; // conservative cap; GitHub's issues/new tolerance is undocumented.

function makeUrl(title: string, body: string): URL {
  const u = new URL(`https://github.com/${FEEDBACK_REPO_SLUG}/issues/new`);
  u.searchParams.set('title', title);
  u.searchParams.set('body', body);
  return u;
}

// Builds a github.com issues/new prefill URL. Always https. Two-stage truncation
// (spec §4.4): drop the auto-appended context block first (preserve user details);
// only if details alone still exceed the cap, truncate details with a marker.
export function buildFeedbackIssueUrl({
  title,
  details,
  context,
}: {
  title: string;
  details: string;
  context: string;
}): string {
  const full = context ? `${details}\n\n---\n${context}` : details;
  let u = makeUrl(title, full);

  if (u.toString().length > MAX_URL) {
    // Stage 1: drop the context block.
    u = makeUrl(title, details);
    if (u.toString().length > MAX_URL) {
      // Stage 2: truncate details. Compute a safe char budget from the headroom
      // left after the base+title (worst-case 3 bytes per char under encoding).
      const marker = '\n\n…(truncated — finish your report in the issue)';
      const overhead = makeUrl(title, marker).toString().length;
      const budget = Math.max(0, Math.floor((MAX_URL - overhead) / 3));
      // Slice by codepoint (spread), not UTF-16 code unit, so a multibyte char
      // (emoji) isn't split into a lone surrogate → replacement-char mojibake.
      const head = [...details].slice(0, budget).join('');
      u = makeUrl(title, head + marker);
    }
  }

  const out = u.toString();
  if (new URL(out).protocol !== 'https:') throw new Error('feedback URL must be https');
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/feedback/feedbackRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/feedback/feedbackRepo.ts frontend/src/feedback/feedbackRepo.test.ts
git commit -m "feat(#211): feedback repo slug + https prefilled-link builder"
```

### Task 14: Frontend feedback API wrapper

**Files:**
- Create: `frontend/src/api/feedback.ts`
- Test: `frontend/src/api/feedback.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.hoisted(() => vi.fn());
class FakeApiError extends Error {
  constructor(public status: number) {
    super(`status ${status}`);
  }
}
vi.mock('./client', () => ({ apiClient: { post }, ApiError: FakeApiError }));

import { submitFeedback } from './feedback';

const req = { category: 'Bug' as const, summary: 's', details: 'd', routePattern: '/', platform: 'browser' };

describe('submitFeedback', () => {
  beforeEach(() => post.mockReset());

  it('returns created on 201', async () => {
    post.mockResolvedValue({ issueNumber: 9, htmlUrl: 'https://x/9' });
    await expect(submitFeedback(req)).resolves.toEqual({ outcome: 'created', issueNumber: 9, htmlUrl: 'https://x/9' });
  });

  it('maps a 422 to cannot-create', async () => {
    post.mockRejectedValue(new FakeApiError(422));
    await expect(submitFeedback(req)).resolves.toEqual({ outcome: 'cannot-create' });
  });

  it('rethrows other errors (5xx/network)', async () => {
    post.mockRejectedValue(new FakeApiError(500));
    await expect(submitFeedback(req)).rejects.toBeInstanceOf(FakeApiError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/api/feedback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { apiClient, ApiError } from './client';

export interface FeedbackRequest {
  category: 'Bug' | 'Idea' | 'Other';
  summary: string;
  details: string;
  routePattern: string;
  platform: string;
}

export type FeedbackResult =
  | { outcome: 'created'; issueNumber: number; htmlUrl: string }
  | { outcome: 'cannot-create' };

// 201 → created; 422 (CannotCreate) → caller falls back to the prefilled link;
// anything else (5xx/network) rethrows for the retry path.
export async function submitFeedback(req: FeedbackRequest): Promise<FeedbackResult> {
  try {
    const res = await apiClient.post<{ issueNumber: number; htmlUrl: string }>('/api/feedback', req);
    return { outcome: 'created', issueNumber: res.issueNumber, htmlUrl: res.htmlUrl };
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) return { outcome: 'cannot-create' };
    throw e;
  }
}
```

> Verify the exact `ApiError` export + field (`status` vs `statusCode`) in `frontend/src/api/client.ts`; adjust if it differs.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/api/feedback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/feedback.ts frontend/src/api/feedback.test.ts
git commit -m "feat(#211): frontend submitFeedback api wrapper"
```

### Task 15: FeedbackDialog component

**Files:**
- Create: `frontend/src/components/Feedback/FeedbackDialog.tsx`
- Create: `frontend/src/components/Feedback/FeedbackDialog.module.css`
- Test: `frontend/src/components/Feedback/FeedbackDialog.test.tsx`

> Implements all spec §5 behaviors: the 5 states, the `host`-gate (security §4.1), reset-on-reopen, initial focus, Esc-when-dirty → Cancel, and focus-on-transition. Build in TDD; the test block below covers each.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const submitFeedback = vi.hoisted(() => vi.fn());
const openExternalSpy = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../../api/feedback', () => ({ submitFeedback }));

import { FeedbackDialog } from './FeedbackDialog';

type Props = React.ComponentProps<typeof FeedbackDialog>;
function open(props: Partial<Props> = {}) {
  const merged: Props = {
    open: true,
    onClose: () => {},
    authed: true,
    host: 'https://github.com',
    routePattern: '/inbox',
    ...props,
  };
  return render(<FeedbackDialog {...merged} />);
}

async function fill() {
  await userEvent.type(screen.getByLabelText(/summary/i), 'It broke');
  await userEvent.type(screen.getByLabelText(/details/i), 'steps');
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    submitFeedback.mockReset();
    openExternalSpy.mockReset().mockResolvedValue(true);
    (window as unknown as { prism?: unknown }).prism = { openExternal: openExternalSpy };
  });

  it('disables submit until category, summary, and details are filled', async () => {
    open();
    const submit = screen.getByRole('button', { name: /send feedback/i });
    expect(submit).toBeDisabled();
    await fill();
    expect(submit).toBeEnabled();
  });

  it('focuses the first category option on open', () => {
    open();
    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveFocus();
  });

  it('warns not to paste secrets or sensitive details', () => {
    open();
    expect(screen.getByText(/don't include tokens, secrets, or sensitive details/i)).toBeInTheDocument();
  });

  it('shows "Filed as #N" on a 201 and opens htmlUrl via the bridge', async () => {
    submitFeedback.mockResolvedValue({ outcome: 'created', issueNumber: 12, htmlUrl: 'https://x/12' });
    open();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByText(/filed as #12/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /open in github/i }));
    expect(openExternalSpy).toHaveBeenCalledWith('https://x/12');
  });

  it('offers the prefilled https link on cannot-create', async () => {
    submitFeedback.mockResolvedValue({ outcome: 'cannot-create' });
    open();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    await userEvent.click(await screen.findByRole('button', { name: /open on github/i }));
    expect(openExternalSpy.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/prpande\/PRism-feedback\/issues\/new/);
  });

  it('first-run (not authed) skips the API and opens the link directly', async () => {
    open({ authed: false });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /open on github/i }));
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  it('GHES (authed, non-github.com host) skips the API — PAT never sent to api.github.com', async () => {
    open({ authed: true, host: 'https://ghe.corp.example' });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /open on github/i }));
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  it('shows an error with Retry on a thrown (5xx) error', async () => {
    submitFeedback.mockRejectedValue(new Error('boom'));
    open();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('Esc keeps the dialog open and focuses Cancel when a field is dirty', async () => {
    const onClose = vi.fn();
    open({ onClose });
    await userEvent.type(screen.getByLabelText(/summary/i), 'typed');
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('resets to a blank idle form when reopened after success', async () => {
    submitFeedback.mockResolvedValue({ outcome: 'created', issueNumber: 1, htmlUrl: 'https://x/1' });
    const { rerender } = open();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    await screen.findByText(/filed as #1/i);
    // Close then reopen.
    rerender(<FeedbackDialog open={false} onClose={() => {}} authed host="https://github.com" routePattern="/inbox" />);
    rerender(<FeedbackDialog open onClose={() => {}} authed host="https://github.com" routePattern="/inbox" />);
    expect(screen.getByLabelText(/summary/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/Feedback/FeedbackDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the CSS**

Create `frontend/src/components/Feedback/FeedbackDialog.module.css`:

```css
.form {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  min-width: 420px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}
.label {
  font-size: var(--text-sm);
  color: var(--text-2);
}
.input,
.textarea {
  width: 100%;
  padding: var(--s-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  background: var(--surface-1);
  color: var(--text-1);
  font: inherit;
}
.textarea {
  min-height: 120px;
  resize: vertical;
}
.notice {
  font-size: var(--text-xs);
  color: var(--text-3);
}
.error {
  color: var(--danger, #d33);
  font-size: var(--text-sm);
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-3);
}
.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
```

- [ ] **Step 4: Implement the dialog**

Create `frontend/src/components/Feedback/FeedbackDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { SegmentedControl } from '../controls/SegmentedControl';
import { submitFeedback, type FeedbackRequest } from '../../api/feedback';
import { buildFeedbackIssueUrl } from '../../feedback/feedbackRepo';
import styles from './FeedbackDialog.module.css';

type Category = 'Bug' | 'Idea' | 'Other';
type State =
  | { kind: 'idle' }
  | { kind: 'in-flight' }
  | { kind: 'success'; issueNumber: number; htmlUrl: string }
  | { kind: 'offer-link' }
  | { kind: 'opened' }
  | { kind: 'error' };

const CATEGORIES: ReadonlyArray<{ value: Category; label: string }> = [
  { value: 'Bug', label: 'Bug' },
  { value: 'Idea', label: 'Idea' },
  { value: 'Other', label: 'Other' },
];

export interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  authed: boolean;
  // The user's configured GitHub host (authState.host). The API path is used only
  // for github.com; any other host (GHES) goes link-only so an enterprise PAT is
  // never sent to public api.github.com (§4.1).
  host: string;
  routePattern: string;
}

function isDesktop(): boolean {
  return typeof window.prism?.openExternal === 'function';
}

async function openExternal(url: string): Promise<void> {
  if (new URL(url).protocol !== 'https:') throw new Error('refusing non-https url');
  if (typeof window.prism?.openExternal === 'function') {
    const ok = await window.prism.openExternal(url);
    if (!ok) throw new Error('openExternal rejected the url');
    return;
  }
  window.open(url, '_blank', 'noreferrer');
}

export function FeedbackDialog({ open, onClose, authed, host, routePattern }: FeedbackDialogProps) {
  const [category, setCategory] = useState<Category>('Bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const liveRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const firstCategoryRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reset to a blank idle form on each open (the component stays mounted while the
  // parent toggles `open`, so without this a second open shows stale success text).
  useEffect(() => {
    if (open) {
      setCategory('Bug');
      setSummary('');
      setDetails('');
      setState({ kind: 'idle' });
    }
  }, [open]);

  // Initial focus: first category option (form-dialog APG convention).
  useEffect(() => {
    if (open && state.kind === 'idle') {
      firstCategoryRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Move focus to the post-idle branch's primary action so keyboard + SR users
  // land on the actionable control (Retry on error, Close/Open-on-GitHub otherwise).
  // Scoped to THIS dialog's root (not document) so a second mounted dialog can't
  // win the match. role="status" is never focused — it announces via its live role.
  useEffect(() => {
    if (state.kind === 'idle' || state.kind === 'in-flight') return;
    rootRef.current
      ?.querySelector<HTMLElement>('[data-modal-role="primary"], [data-feedback-close]')
      ?.focus();
  }, [state.kind]);

  // Normalize the host before comparing (the backend treats github.com
  // case-insensitively and ignores a trailing slash via Uri parsing). Exact-string
  // matching would wrongly classify 'https://github.com/' or 'https://GitHub.com'
  // as GHES and force a legitimate user link-only.
  const isGitHubCom = (() => {
    try {
      return new URL(host).hostname.toLowerCase() === 'github.com';
    } catch {
      return false;
    }
  })();
  const linkOnly = !authed || !isGitHubCom;
  const canSubmit = Boolean(category && summary.trim() && details.trim()) && state.kind === 'idle';
  const submitLabel = linkOnly ? 'Open on GitHub' : 'Send feedback';
  const dirty = Boolean(summary || details);

  const prefilledUrl = () =>
    buildFeedbackIssueUrl({
      title: `[${category}] ${summary.trim()}`,
      details: details.trim(),
      context: `route: ${routePattern}\nplatform: ${isDesktop() ? 'desktop' : 'browser'}`,
    });

  async function goToLink() {
    try {
      await openExternal(prefilledUrl());
      setState({ kind: 'opened' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  async function onSubmit() {
    if (linkOnly) return goToLink();
    // Announce start: the submit button is about to be disabled, which strands
    // focus on <body>; the polite live region tells SR users what's happening.
    if (liveRef.current) liveRef.current.textContent = 'Sending your feedback…';
    setState({ kind: 'in-flight' });
    try {
      const req: FeedbackRequest = {
        category,
        summary: summary.trim(),
        details: details.trim(),
        routePattern,
        platform: isDesktop() ? 'desktop' : 'browser',
      };
      const res = await submitFeedback(req);
      if (res.outcome === 'created') setState({ kind: 'success', issueNumber: res.issueNumber, htmlUrl: res.htmlUrl });
      else setState({ kind: 'offer-link' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  // Esc when dirty focuses Cancel instead of dismissing (mirrors SubmitDialog).
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && dirty && state.kind !== 'in-flight') {
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current?.focus();
      if (liveRef.current) liveRef.current.textContent = 'Press Cancel to discard, or keep editing.';
    }
  }

  const title =
    state.kind === 'success'
      ? 'Feedback sent'
      : state.kind === 'offer-link' || state.kind === 'opened'
        ? 'Open on GitHub'
        : 'Send feedback';

  // disableEscDismiss while in-flight, and while dirty (we handle Esc ourselves above).
  return (
    <Modal open={open} title={title} onClose={onClose} disableEscDismiss={state.kind === 'in-flight' || dirty}>
      <div ref={rootRef} data-feedback-active onKeyDown={onKeyDown}>
        <div ref={liveRef} className={styles.srOnly} role="status" aria-live="polite" />
        {state.kind === 'success' ? (
          <div>
            <p>
              Filed as #{state.issueNumber}.{' '}
              {state.htmlUrl && (
                <button type="button" className="btn btn-secondary" onClick={() => void openExternal(state.htmlUrl)}>
                  Open in GitHub
                </button>
              )}
            </p>
            <div className={styles.footer}>
              <button type="button" className="btn btn-primary" data-modal-role="primary" data-feedback-close onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : state.kind === 'offer-link' || state.kind === 'opened' ? (
          <div>
            <p>
              {state.kind === 'opened'
                ? 'A prefilled issue page was opened. Submit it there, then return here.'
                : "Couldn't file it directly. Open a prefilled issue on GitHub instead?"}
            </p>
            <div className={styles.footer}>
              {state.kind === 'offer-link' && (
                <button type="button" className="btn btn-primary" data-modal-role="primary" onClick={() => void goToLink()}>
                  Open on GitHub
                </button>
              )}
              <button type="button" className="btn btn-secondary" data-feedback-close onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.form}>
            <div ref={firstCategoryRef}>
              <SegmentedControl
                label="Feedback category"
                options={CATEGORIES}
                value={category}
                onChange={(v) => setCategory(v)}
                disabled={state.kind === 'in-flight'}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="fb-summary">
                Summary
              </label>
              <input
                id="fb-summary"
                className={styles.input}
                maxLength={120}
                value={summary}
                disabled={state.kind === 'in-flight'}
                onChange={(e) => setSummary(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="fb-details">
                Details
              </label>
              <textarea
                id="fb-details"
                className={styles.textarea}
                maxLength={4000}
                placeholder="What happened, and what did you expect? Describe the steps — please don't paste raw logs."
                value={details}
                disabled={state.kind === 'in-flight'}
                onChange={(e) => setDetails(e.target.value)}
              />
            </div>
            <p className={styles.notice}>
              Posted as a public GitHub issue under your account — don't include tokens, secrets, or
              sensitive details (internal project names, PR content).
            </p>
            {state.kind === 'error' && (
              <p className={styles.error} role="alert">
                Couldn't send your feedback. Try again, or open a prefilled issue on GitHub.
              </p>
            )}
            <div className={styles.footer}>
              {state.kind === 'error' ? (
                <>
                  <button type="button" className="btn btn-primary" data-modal-role="primary" onClick={() => void onSubmit()}>
                    Retry
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => void goToLink()}>
                    Open on GitHub instead
                  </button>
                  <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-modal-role="primary"
                    disabled={!canSubmit}
                    onClick={() => void onSubmit()}
                  >
                    {state.kind === 'in-flight' ? 'Sending…' : submitLabel}
                  </button>
                  <button ref={cancelRef} type="button" className="btn btn-ghost" disabled={state.kind === 'in-flight'} onClick={onClose}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
```

> Confirm `Modal` (`disableEscDismiss`, `data-modal-role` focus selector) and `SegmentedControl` (`onChange: (value) => void`, renders `role="radio"` options) against their real implementations; adjust prop names if they differ. `.btn`/`.btn-primary`/`.btn-secondary`/`.btn-ghost` are the app's global button classes — use whichever ghost/tertiary class exists (check `SubmitDialog`/`ErrorModal`). If `Modal` keeps focus trapped such that the initial-focus effect fights it, set the category control via the Modal's own initial-focus mechanism instead (check whether Modal honors `data-modal-role` or a `defaultFocus` prop for a non-button target).

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/Feedback/FeedbackDialog.test.tsx`
Expected: PASS (all cases). If the initial-focus or Esc test fails due to Modal internals, adjust the focus mechanism per the note above until green — do not weaken the assertions.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Feedback/
git commit -m "feat(#211): FeedbackDialog with API path, host gate, link fallback, a11y states"
```

### Task 16: Wire the "Send feedback" triggers (HelpPage + welcome footer)

**Files:**
- Modify: `frontend/src/pages/HelpPage.tsx` (+ test)
- Modify: `frontend/src/pages/WelcomePage.tsx` (+ test)

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/pages/HelpPage.test.tsx` (the existing `renderHelp` wraps in `MemoryRouter`; the dialog reads `useAuth`, so mock it at the top of the file):

```tsx
// top of HelpPage.test.tsx
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ authState: { hasToken: true, host: 'https://github.com' }, error: null, refetch: vi.fn() }),
}));
```

```tsx
it('opens the feedback dialog from the Send feedback button', async () => {
  const user = (await import('@testing-library/user-event')).default;
  renderHelp();
  await user.click(screen.getByRole('button', { name: /send feedback/i }));
  expect(screen.getByRole('dialog', { name: /send feedback/i })).toBeInTheDocument();
});
```

Add to `frontend/src/pages/WelcomePage.test.tsx`:

```tsx
it('opens the feedback dialog from the Send feedback footer button', async () => {
  const user = (await import('@testing-library/user-event')).default;
  render(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Send feedback' }));
  expect(screen.getByRole('dialog', { name: /send feedback/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/pages/HelpPage.test.tsx src/pages/WelcomePage.test.tsx`
Expected: FAIL — no Send feedback button / dialog.

- [ ] **Step 3: Add the trigger to HelpPage**

In `frontend/src/pages/HelpPage.tsx`, add imports + state, derive `authed`/`host` from `useAuth`, and render the button + dialog. The Help page reaches all auth states, so source both props from auth:

```tsx
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useLocation } from 'react-router-dom';
import { FeedbackDialog } from '../components/Feedback/FeedbackDialog';
```

```tsx
  const { authState } = useAuth();
  const authed = Boolean(authState?.hasToken);
  const host = authState?.host ?? 'https://github.com';
  const location = useLocation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
```

After the shortcuts `<section>`, before `</main>`:

```tsx
      <button type="button" className={`btn btn-primary ${styles.feedbackAction}`} onClick={() => setFeedbackOpen(true)}>
        Send feedback
      </button>
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        authed={authed}
        host={host}
        routePattern={location.pathname}
      />
```

> `routePattern={location.pathname}` is pattern-safe here because `/help` and `/welcome` are static routes with no `:param`. A future trigger inside PR-detail MUST pass the matched route pattern (e.g. `/pr/:owner/:repo/:number`), not the concrete path, to avoid leaking repo/PR identifiers into a public issue.

- [ ] **Step 4: Add the trigger to WelcomePage**

In `frontend/src/pages/WelcomePage.tsx`, replace the `Send feedback` stub `<span>` with a button + dialog. `/welcome` is first-run, so `authed={false}` and `host` defaults to github.com:

```tsx
import { useState } from 'react';
import { FeedbackDialog } from '../components/Feedback/FeedbackDialog';
```

```tsx
  const [feedbackOpen, setFeedbackOpen] = useState(false);
```

```tsx
          <button type="button" className={styles.footerLink} onClick={() => setFeedbackOpen(true)}>
            Send feedback
          </button>
```

Before the card's closing element:

```tsx
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        authed={false}
        host="https://github.com"
        routePattern="/welcome"
      />
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd frontend && npx vitest run src/pages/HelpPage.test.tsx src/pages/WelcomePage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/HelpPage.tsx frontend/src/pages/HelpPage.test.tsx frontend/src/pages/WelcomePage.tsx frontend/src/pages/WelcomePage.module.css frontend/src/pages/WelcomePage.test.tsx
git commit -m "feat(#211): wire Send feedback trigger on Help + Welcome"
```

### Task 17: Playwright e2e — feedback dialog

**Files:**
- Create: `frontend/e2e/feedback.spec.ts`

- [ ] **Step 1: Write the e2e test**

```ts
import { test, expect } from '@playwright/test';

test('feedback dialog opens, validates, and offers a prefilled link on cannot-create', async ({ page }) => {
  // Stub the backend so CI doesn't hit real GitHub.
  await page.route('**/api/feedback', (route) => route.fulfill({ status: 422, body: '{"error":"cannot-create"}' }));

  await page.goto('/help');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const dialog = page.getByRole('dialog', { name: /send feedback/i });
  await expect(dialog).toBeVisible();

  const submit = dialog.getByRole('button', { name: /send feedback|open on github/i });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/summary/i).fill('e2e summary');
  await dialog.getByLabel(/details/i).fill('e2e details');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog.getByRole('button', { name: /open on github/i })).toBeVisible();
});
```

> Mirror sibling specs' auth bootstrap + route-stub style.

- [ ] **Step 2: Run the e2e spec**

Run: `cd frontend && npx playwright test e2e/feedback.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/feedback.spec.ts
git commit -m "test(#211): e2e for feedback dialog"
```

### Task 18: PR2 pre-push checklist + open PR

- [ ] **Step 1: Full local gate**

```bash
cd D:/src/PRism-wt/210-211-help-feedback
dotnet build --configuration Release
dotnet test
cd frontend
node ./node_modules/prettier/bin/prettier.cjs --check .
npm run lint
npm run build
npx vitest run
```
Expected: all green. (Run one long build/test at a time.)

- [ ] **Step 2: Secrets scan** over the diff (the design ships no token; the repo slug is public). Record in `## Proof`.

- [ ] **Step 3: Sync main, then ship via pr-autopilot**

Fetch + merge `origin/main`, then `pr-autopilot`. **B2-gated** (GitHub write surface) + B1 (dialog UI). The pre-PR-open re-check (re-read the diff vs the risk table) confirms no *additional* risk surface was touched beyond what the spec/plan gated. Drive to green-and-ready, then notify the human with the PR link, `## Proof`, and B1 screenshots (dialog states + `/help`). Human merges.

---

## Self-review

**Spec coverage** (each spec section → task):
- §3 `/help` route + entry points → Tasks 3, 4, 5.
- §4.1 host resolution / api.github.com client / **host gate (two-tier)** → Task 10 (named `github.com` client; 401/403/404/422→CannotCreate; **backend short-circuits to CannotCreate for any non-github.com host so the PAT is never read/egressed — defense-in-depth, not frontend-only**) + Task 15 (`linkOnly = !authed || !isGitHubCom`, host **normalized** via `new URL().hostname`, with a GHES test asserting the API isn't called). Backend + frontend agree on "is github.com."
- §4.2 issue construction (title prefix, allowlisted body, version + timestamp) → Tasks 9, 10, 12.
- §4.3 user-PAT rationale → design rationale (no code).
- §4.4 prefilled-link (https-validated, two-stage Context-first truncation, openExternal divergence) → Tasks 13, 15.
- §4.5 slug constant + single-side guard → Tasks 8, 13.
- §5 HelpPage + Header `?` + welcome wiring + FeedbackDialog (5 states, initial focus, Esc-dirty→Cancel, focus-on-transition, reset-on-reopen) → Tasks 2, 4, 5, 15, 16.
- §6 endpoint + submitter + status mapping → Tasks 9, 10, 12.
- §8 error handling (401/403/404/422→CannotCreate, https guard, field caps) → Tasks 10, 12, 13, 15.
- §9 testing → tests in every task + Tasks 6, 17 (e2e).
- §10 phasing → PR1 / PR2 split.
- §11 deferrals → D1/D2 not implemented by design; D3 (no labels) in Task 10; D4 (build constant) in Tasks 8, 13.
- §12 ACs → covered; slug AC is the single-side guard (deviation #3, honestly scoped).

**Placeholder scan:** none — every step has concrete code/commands. The one external-verification hooks (Task 2 Step 0 keybinding; Modal/SegmentedControl/ApiError prop confirmation) are explicit verify-steps, not placeholders.

**Type consistency:** `FeedbackContent` (now 7 fields incl. Version + SubmittedAt) consistent across Tasks 9/10/12; `IFeedbackSubmitter.CreateFeedbackIssueAsync` identical in interface (9), impl (10), endpoint (12), and fakes; `FeedbackOutcome` Created/CannotCreate consistent; frontend `FeedbackResult` (`'created'`/`'cannot-create'`) consistent across Tasks 14/15; `FeedbackDialogProps` (`open/onClose/authed/host/routePattern`) consistent between Task 15 def and Task 16 call sites; `buildFeedbackIssueUrl({title, details, context})` consistent between Tasks 13 and 15; `FEEDBACK_REPO_SLUG`/`FeedbackRepo.Slug` both `"prpande/PRism-feedback"`.

**Round-2 ce-doc-review fixes applied:** dropped `TimeProvider` (not DI-registered → would 500; `DateTimeOffset.UtcNow` inline, no test needs a seam); **added the backend host guard** (the GHES-PAT-egress property is now enforced on both tiers, not frontend-only); normalized the frontend host check; error-state focus now lands on Retry (not an empty live region); in-flight start is announced via the live region; the focus-on-transition query is scoped to the dialog root ref (not `document`, so concurrent mounts can't cross-focus); codepoint-safe truncation; line endings stripped from `routePattern`/`platform` server-side.

**Deferred as minor (verified working / cosmetic):** the `firstCategoryRef` → `querySelector('[role="radio"]')` initial-focus mechanism (feasibility confirmed SegmentedControl renders `role="radio"` and child-effect-before-parent ordering makes the dialog win focus over Modal — the test pins it); the distinct `opened` state vs an `offer-link {hasOpened}` flag (cosmetic; left as a named state for readability); the empty-`htmlUrl` success branch lacks a dedicated test (the Open-in-GitHub link is simply hidden — benign).

**Open verification items for the executor** (mechanical, flagged not hidden): the real ⌘K binding (Task 2 Step 0); `ApiError` field name `status` vs `statusCode` (Task 14); `Modal`/`SegmentedControl` exact prop names (Task 15 Step 4 note).
