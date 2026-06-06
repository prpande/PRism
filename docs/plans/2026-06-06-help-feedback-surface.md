# Help & Feedback Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app `/help` guide (#210) and an in-app feedback form that files a GitHub issue in the public `prpande/PRism-feedback` repo with a prefilled-link fallback (#211), as one coherent Help+Feedback area.

**Architecture:** Frontend-only Help page on an auth-agnostic `/help` route reached from a header `?` icon and the `/welcome` footer (PR1). Feedback dialog → new `POST /api/feedback` → `IFeedbackSubmitter` (`GitHubFeedbackSubmitter` in `PRism.GitHub`) that POSTs an issue to `api.github.com` with the user's PAT; on `CannotCreate`/first-run/non-github.com host the frontend opens an https-validated prefilled `issues/new` link via `window.prism.openExternal` (PR2).

**Tech Stack:** React 19 + Vite + TypeScript + react-router (frontend); .NET 10 minimal API + `IHttpClientFactory` (backend); vitest + @testing-library/react (FE tests); xUnit + FluentAssertions + `WebApplicationFactory` (BE tests); Playwright (e2e).

**Source spec:** `docs/specs/2026-06-06-help-feedback-surface-design.md`.

## Plan deviations from the spec (documented per behavioral guidelines)

1. **`IFeedbackSubmitter` interface is kept** (spec §6 round-2 said "no `PRism.Core` interface, internal class"). Rationale: the endpoint integration test substitutes the submitter via the repo's universal `services.RemoveAll<IInterface>(); services.AddSingleton<IInterface>(fake)` pattern (used for `IReviewSubmitter`, `IReviewEventBus`, `IActivePrCache`). A concrete-class dependency can't be substituted that way without an awkward HttpClient-handler injection. The interface is the established testability seam, single-method, mirroring `IReviewAuth`. This is a convention-alignment win over the YAGNI suggestion, not gratuitous abstraction.
2. **The api.github.com header block is inlined in the submitter** (spec §4.1 allowed "extracted helper, or inlined"). Inlining 4 header lines avoids refactoring `GitHubReviewService`'s private `SendGitHubAsync` on a B2 surface — lower blast radius.
3. **The cross-tier slug "drift guard" is a pinned-literal assertion in both suites** (spec §4.5 allowed "duplicated literal + test, or codegen"). A C#/TS runtime cross-check isn't feasible without a shared artifact; instead each tier's test pins its constant to `"prpande/PRism-feedback"`, so a rename fails both suites loudly. Honest weak guard, as the spec acknowledged.

## File structure

**PR1 — Help surface (#210), frontend-only:**
- Create `frontend/src/components/Header/HelpIcon.tsx` — inline `?` SVG icon.
- Create `frontend/src/pages/HelpPage.tsx` + `HelpPage.module.css` — static guide.
- Create `frontend/src/pages/HelpPage.test.tsx`.
- Modify `frontend/src/components/Header/Header.tsx` (+ `Header.module.css`) — add the `?` link.
- Modify `frontend/src/components/Header/Header.test.tsx`.
- Modify `frontend/src/App.tsx` — add `/help` route; `frontend/src/App.test.tsx` (route test) if present, else a new `HelpRoute.test.tsx`.
- Modify `frontend/src/pages/WelcomePage.tsx` (+ `WelcomePage.module.css`, `WelcomePage.test.tsx`) — `Help` stub → link.
- Modify `frontend/e2e/` — a Playwright spec for `/help` reachability.

**PR2 — Feedback pipeline (#211):**
- Create `frontend/src/feedback/feedbackRepo.ts` (+ test) — repo slug constant + prefilled-link builder.
- Create `frontend/src/feedback/feedbackRepo.test.ts`.
- Create `frontend/src/api/feedback.ts` (+ test) — `postFeedback` wrapper + types.
- Create `frontend/src/components/Feedback/FeedbackDialog.tsx` (+ `.module.css`, `.test.tsx`).
- Modify `frontend/src/pages/HelpPage.tsx` + `frontend/src/pages/WelcomePage.tsx` — wire the `Send feedback` trigger.
- Create `PRism.Core/Feedback/IFeedbackSubmitter.cs` (interface + `FeedbackContent`/`FeedbackCreateResult` types).
- Create `PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs` + `FeedbackRepo.cs`.
- Modify `PRism.GitHub/ServiceCollectionExtensions.cs` — register the `github.com` client + the submitter.
- Create `PRism.Web/Endpoints/FeedbackEndpoints.cs` + `FeedbackDtos.cs`.
- Modify `PRism.Web/Program.cs` — `app.MapFeedback()`.
- Modify `PRism.Web/PRism.Web.csproj` (or add `Directory.Build.props`) — set a real `<InformationalVersion>`.
- Create tests under `tests/PRism.GitHub.Tests/` and `tests/PRism.Web.Tests/`.

---

# PR1 — Help surface (#210)

> Frontend-only, B1 only. Independently shippable; its value does not depend on PR2. The `/welcome` `Send feedback` stub and the HelpPage feedback button are left for PR2.

### Task 1: HelpIcon component

**Files:**
- Create: `frontend/src/components/Header/HelpIcon.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Header/HelpIcon.test.tsx`:

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

Create `frontend/src/components/Header/HelpIcon.tsx` (mirrors `diffIcons.tsx` `SVG_PROPS` + `currentColor` convention):

```tsx
// Inline "?" help glyph. Monochrome currentColor so theme/hover is driven by CSS.
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

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/HelpPage.test.tsx`:

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

  it('links token guidance to the GitHub-connection settings and #213', () => {
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
```

Create `frontend/src/pages/HelpPage.tsx`. Copy follows the anti-AI-slop constraints: task-first openers, exact in-app labels, no emoji in headings.

```tsx
import { Link } from 'react-router-dom';
import styles from './HelpPage.module.css';

// Static, scannable guide (#210). No data fetch → no loading/empty state; all
// content is bundled and renders synchronously. Copy is task-first and names
// the real in-app surfaces (Inbox, Files, Submit) verbatim.
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
          cheatsheet.
        </p>
      </section>
    </main>
  );
}
```

> Note: the "Send feedback" button is intentionally **not** here yet — it is added in PR2 Task 16 together with the dialog it opens, so PR1 ships no dead control.

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
- Modify: `frontend/src/App.tsx` (route table, ~lines 116–148)
- Test: `frontend/src/pages/HelpPage.route.test.tsx` (new — self-contained route test)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/HelpPage.route.test.tsx`. It asserts `/help` resolves in both unauthed and authed states by rendering the real `App` route table is heavy; instead assert the route element is present by mounting a minimal Routes mirror is brittle. Use the app's existing auth mock convention (see `InboxPage.test.tsx`) to render `App` at `/help`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Mock auth so we control hasToken/authInvalidated. Shape mirrors useAuth().
const authState = vi.hoisted(() => ({ value: { hasToken: false, host: 'https://github.com' } as Record<string, unknown> }));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ authState: authState.value, error: null, refetch: vi.fn() }),
}));

import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';

function renderAppAt(path: string) {
  // App uses useLocation/Routes internally; wrap in MemoryRouter at `path`.
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('/help route', () => {
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

> If `App` is not exported or cannot mount under a test `MemoryRouter` because it renders its own `BrowserRouter`, check `frontend/src/main.tsx`: the router wraps `<App/>` there, so `App` itself contains `Routes` (confirmed in `App.tsx`). Mounting `<App/>` inside `MemoryRouter` is valid.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/HelpPage.route.test.tsx`
Expected: FAIL — `/help` falls through to the `*` redirect, so `help-page` is not in the document.

- [ ] **Step 3: Add the route**

In `frontend/src/App.tsx`, import `HelpPage` and add a `/help` route **outside** the `isAuthed` gates (alongside `/welcome`/`/setup`, before the `*` catch-all):

```tsx
import { HelpPage } from './pages/HelpPage';
```

```tsx
            {/* #210: Help is reachable in every auth state (first-run users
                need it most), so it sits outside the isAuthed gates like
                /welcome. No auth redirect. */}
            <Route path="/help" element={<HelpPage />} />
```

Place this line immediately after the `<Route path="/setup" .../>` line.

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
- Modify: `frontend/src/components/Header/Header.module.css`
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

In `frontend/src/components/Header/Header.tsx`, import the icon and add `helpActive`, then render the link beside the gear (inside the existing `{isAuthed && (…)}` region, before the gear `<Link>`):

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

This reuses the `.gear`/`.gearOn` icon-button classes — no new CSS needed. (If a distinct hit-area is desired later, add a `.help` class composing `.gear`; not required now.)

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
- Modify: `frontend/src/pages/WelcomePage.tsx` (lines ~41–47)
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
Expected: FAIL — `Help` is a `<span>`, not a link.

- [ ] **Step 3: Convert the Help stub to a link**

In `frontend/src/pages/WelcomePage.tsx`, change the Help stub. Keep `Send feedback` a stub for now (PR2 wires it):

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

Ensure `import { Link } from 'react-router-dom';` is present at the top.

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
- Create: `frontend/e2e/help.spec.ts` (match the existing e2e dir/naming — verify with `git ls-files frontend/e2e`)

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

> Match the project's e2e auth bootstrap: inspect a sibling spec in `frontend/e2e/` for how an authed session is seeded (test PAT / storage state) and mirror it. If the suite has a "first-run" fixture, add a case asserting the `/welcome` `Help` link reaches `/help`.

- [ ] **Step 2: Run the e2e spec**

Run: `cd frontend && npx playwright test e2e/help.spec.ts`
Expected: PASS (after seeding the same auth state sibling specs use).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/help.spec.ts
git commit -m "test(#210): e2e for /help reachability"
```

### Task 7: PR1 pre-push checklist + open PR

- [ ] **Step 1: Full local gate** (per `.ai/docs/development-process.md`; run prettier directly, not via rtk — see project conventions):

```bash
cd D:/src/PRism-wt/210-211-help-feedback/frontend
node ./node_modules/prettier/bin/prettier.cjs --check .
npm run lint
npm run build
npx vitest run
```
Expected: all green.

- [ ] **Step 2: Sync main, then ship via pr-autopilot**

Fetch + merge `origin/main` into the branch, then use the `pr-autopilot` skill to open PR1. PR body must include the `## Proof` section (non-bug work: new tests authored test-first + AC checklist + secrets scan). This is a **B1-gated** PR — pr-autopilot drives to green-and-ready, then pause for the human visual assert (screenshots of `/help` on the PR per the visual-verification convention).

---

# PR2 — Feedback pipeline (#211)

> Carries the B2 risk surface (GitHub write with the user's PAT). Branch from main **after PR1 merges** (or stack on the same branch if shipping together — decide at execution).

### Task 8: Backend feedback-repo constant + pinned-literal test

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
    // Pinned-literal drift guard (plan deviation #3). The frontend pins the same
    // literal in feedbackRepo.test.ts; a repo rename fails BOTH suites.
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
// not in state.json. Mirrored by the frontend FEEDBACK_REPO_SLUG; both pin the
// same literal so a rename fails both test suites (plan deviation #3).
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

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/Feedback/FeedbackTypesTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Feedback;
using Xunit;

namespace PRism.Core.Tests.Feedback;

public class FeedbackTypesTests
{
    [Fact]
    public void FeedbackContent_carries_the_allowlisted_fields()
    {
        var c = new FeedbackContent("Bug", "Summary", "Details", "/pr/:owner/:repo/:number", "desktop");
        c.Category.Should().Be("Bug");
        c.RoutePattern.Should().Be("/pr/:owner/:repo/:number");
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
// RoutePattern/Platform are machine context. Version + timestamp are stamped by
// the endpoint, not carried here.
public sealed record FeedbackContent(
    string Category,
    string Summary,
    string Details,
    string RoutePattern,
    string Platform);

public enum FeedbackOutcome
{
    Created,
    // GitHub returned 403/404/422 — the user's token can't create the issue.
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

// Single-method seam. Kept as an interface (not a concrete class) so endpoint
// tests substitute a fake via services.RemoveAll/AddSingleton — the repo's
// universal pattern for GitHub-touching services (cf. IReviewSubmitter).
public interface IFeedbackSubmitter
{
    // Returns Created on 201, CannotCreate on 403/404/422. Throws HttpRequestException
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
        new("Bug", "It broke", "Steps: do X", "/pr/:owner/:repo/:number", "desktop");

    private static GitHubFeedbackSubmitter NewSubmitter(HttpMessageHandler handler) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("ghp_test"));

    [Fact]
    public async Task Posts_to_api_github_com_issues_with_title_and_body()
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
        doc.RootElement.GetProperty("body").GetString().Should().Contain("Steps: do X");
        // Labels omitted on the first cut (D3): no labels field.
        doc.RootElement.TryGetProperty("labels", out _).Should().BeFalse();
        result.Outcome.Should().Be(FeedbackOutcome.Created);
        result.IssueNumber.Should().Be(12);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.UnprocessableEntity)]
    public async Task Maps_403_404_422_to_CannotCreate(HttpStatusCode status)
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
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubFeedbackSubmitterTests`
Expected: FAIL — `GitHubFeedbackSubmitter` not found.

- [ ] **Step 3: Implement the submitter**

Create `PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs`:

```csharp
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PRism.Core.Feedback;

namespace PRism.GitHub.Feedback;

// Creates a feedback issue in the public prpande/PRism-feedback repo using the
// user's PAT. Targets api.github.com via its own named client (NOT the host-scoped
// "github" client) — the feedback repo lives on github.com unconditionally (spec
// §4.1). Headers are inlined (plan deviation #2) to avoid touching GitHubReviewService.
public sealed class GitHubFeedbackSubmitter : IFeedbackSubmitter
{
    public const string ClientName = "github.com";

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubFeedbackSubmitter(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);

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

        // 403 (scope/permission/rate-limit), 404 (fine-grained can't see repo),
        // 422 (validation/missing-label) all degrade to the prefilled-link fallback.
        if (resp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.NotFound or HttpStatusCode.UnprocessableEntity)
            return FeedbackCreateResult.CannotCreate();

        resp.EnsureSuccessStatusCode(); // genuine transport/5xx → throw → endpoint 500

        var responseBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;
        var number = root.TryGetProperty("number", out var n) && n.ValueKind == JsonValueKind.Number ? n.GetInt32() : 0;
        var htmlUrl = root.TryGetProperty("html_url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "";
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
        sb.AppendLine("```");
        return sb.ToString();
    }
}
```

- [ ] **Step 4: Register the client + the submitter in DI**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, after the existing `services.AddHttpClient("github", …)` block, add:

```csharp
        // Feedback always targets github.com (the feedback repo lives there),
        // independent of the user's configured host (spec §4.1).
        services.AddHttpClient(PRism.GitHub.Feedback.GitHubFeedbackSubmitter.ClientName, client =>
        {
            client.BaseAddress = new Uri("https://api.github.com/");
        });

        services.AddSingleton<PRism.Core.Feedback.IFeedbackSubmitter>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new PRism.GitHub.Feedback.GitHubFeedbackSubmitter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None));
        });
```

(Match the namespaces already imported at the top of the file; add `using` for `PRism.Core.Feedback;` / `PRism.GitHub.Feedback;` if the file uses usings rather than fully-qualified names.)

- [ ] **Step 5: Run to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubFeedbackSubmitterTests`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/Feedback/GitHubFeedbackSubmitterTests.cs
git commit -m "feat(#211): GitHubFeedbackSubmitter posts issue to api.github.com"
```

### Task 11: Wire a real build version

**Files:**
- Modify: `PRism.Web/PRism.Web.csproj`
- Create: `PRism.Web/Endpoints/AppVersion.cs` (helper)
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
    public void Current_is_a_real_non_default_version()
    {
        AppVersion.Current.Should().NotBe("1.0.0.0");
        AppVersion.Current.Should().NotBeNullOrWhiteSpace();
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter AppVersionTests`
Expected: FAIL — `AppVersion` not found (and version would be `1.0.0.0`).

- [ ] **Step 3: Set the version + add the helper**

In `PRism.Web/PRism.Web.csproj`, inside the first `<PropertyGroup>`, add (match the desktop shell's `0.2.0`):

```xml
    <InformationalVersion>0.2.0</InformationalVersion>
```

Create `PRism.Web/Endpoints/AppVersion.cs`:

```csharp
using System.Reflection;

namespace PRism.Web.Endpoints;

// Authoritative build version for the feedback context (spec §4.2). Reads the
// assembly InformationalVersion set in PRism.Web.csproj. Falls back to the
// assembly version only if the attribute is somehow absent.
internal static class AppVersion
{
    public static string Current { get; } =
        typeof(AppVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(AppVersion).Assembly.GetName().Version?.ToString()
        ?? "unknown";
}
```

> Note: SDK builds may append a `+<git-sha>` suffix to `InformationalVersion`. That's fine for triage (and still `!= "1.0.0.0"`); the test only asserts it's non-default.

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
- Modify: `PRism.Web/Program.cs` (registration list, ~line 318)
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
        public Func<FeedbackContent, FeedbackCreateResult>? Responder { get; set; }
        public Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct)
        {
            Last = content;
            return Task.FromResult(Responder?.Invoke(content) ?? Result);
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
    public async Task Created_returns_201_with_issue_number()
    {
        var (f, sub) = NewApp();
        sub.Result = FeedbackCreateResult.Created(42, "https://github.com/prpande/PRism-feedback/issues/42");
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback", ValidBody());
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        var dto = await resp.Content.ReadFromJsonAsync<FeedbackResponseDto>();
        dto!.IssueNumber.Should().Be(42);
        sub.Last!.Category.Should().Be("Bug");
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
    public async Task Missing_summary_returns_400()
    {
        var (f, _) = NewApp();
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback",
            new { category = "Bug", summary = "  ", details = "x", routePattern = "/", platform = "browser" });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Oversize_details_returns_400()
    {
        var (f, _) = NewApp();
        using var client = f.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/feedback",
            new { category = "Bug", summary = "ok", details = new string('x', 4001), routePattern = "/", platform = "browser" });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter FeedbackEndpointTests`
Expected: FAIL — endpoint + `FeedbackResponseDto` not found (404s).

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

        if (request.Summary!.Length > MaxSummary || request.Details!.Length > MaxDetails)
            return Results.BadRequest(new FeedbackErrorDto("field-too-long"));

        // Append the authoritative version + timestamp to the platform context so
        // the user can't forge them. RoutePattern/Platform are passed through as the
        // allowlisted machine context (no arbitrary client object is forwarded).
        var platform = $"{request.Platform ?? "unknown"} · PRism {AppVersion.Current}";
        var content = new FeedbackContent(
            request.Category!,
            request.Summary!.Trim(),
            request.Details!.Trim(),
            request.RoutePattern ?? "unknown",
            platform);

        var result = await submitter.CreateFeedbackIssueAsync(content, ct).ConfigureAwait(false);
        return result.Outcome == FeedbackOutcome.Created
            ? Results.Created(result.HtmlUrl!, new FeedbackResponseDto(result.IssueNumber!.Value, result.HtmlUrl!))
            : Results.Json(new FeedbackErrorDto("cannot-create"), statusCode: StatusCodes.Status422UnprocessableEntity);
    }
}
```

> A thrown `HttpRequestException` from the submitter (genuine 5xx) is **not** caught here, so it surfaces as the framework's 500 — which is the spec's "transport/5xx → 500 → frontend retry" contract. (If the repo has global exception middleware that rewrites 500s, confirm it still yields a 5xx status; mirror the `PrRootCommentEndpoints` try/catch returning `Results.Json(..., 500)` if explicit mapping is preferred.)

- [ ] **Step 5: Register in Program.cs**

In `PRism.Web/Program.cs`, add to the `app.Map…()` block (near line 318):

```csharp
app.MapFeedback();
```

- [ ] **Step 6: Run to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter FeedbackEndpointTests`
Expected: PASS (all 4 cases).

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
  it('pins the public feedback repo slug (drift guard — matches backend FeedbackRepo.Slug)', () => {
    expect(FEEDBACK_REPO_SLUG).toBe('prpande/PRism-feedback');
  });

  it('builds an https issues/new URL with encoded title and body', () => {
    const url = buildFeedbackIssueUrl({ title: '[Bug] a b', body: 'line1\nline2' });
    const u = new URL(url);
    expect(u.protocol).toBe('https:');
    expect(u.host).toBe('github.com');
    expect(u.pathname).toBe('/prpande/PRism-feedback/issues/new');
    expect(u.searchParams.get('title')).toBe('[Bug] a b');
    expect(u.searchParams.get('body')).toBe('line1\nline2');
  });

  it('truncates the body when the encoded URL would exceed the cap', () => {
    const url = buildFeedbackIssueUrl({ title: 'x', body: 'y'.repeat(10000) });
    expect(url.length).toBeLessThanOrEqual(6144);
    expect(new URL(url).searchParams.get('body')).toContain('(truncated');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/feedback/feedbackRepo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// The public feedback repo (#211). Pinned literal — mirrors backend FeedbackRepo.Slug;
// both suites assert this exact value so a rename fails loudly on both sides.
export const FEEDBACK_REPO_SLUG = 'prpande/PRism-feedback';

const MAX_URL = 6144; // conservative cap; GitHub's issues/new tolerance is undocumented.

// Builds a github.com issues/new prefill URL. Always https. Truncates the body
// (never the title) on the encoded length so the URL stays under MAX_URL.
export function buildFeedbackIssueUrl({ title, body }: { title: string; body: string }): string {
  const base = `https://github.com/${FEEDBACK_REPO_SLUG}/issues/new`;
  const make = (b: string) => {
    const u = new URL(base);
    u.searchParams.set('title', title);
    u.searchParams.set('body', b);
    return u;
  };
  let u = make(body);
  if (u.toString().length > MAX_URL) {
    const marker = '\n\n…(truncated — finish your report here)';
    // Binary-trim the body until under the cap.
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (make(body.slice(0, mid) + marker).toString().length <= MAX_URL) lo = mid;
      else hi = mid - 1;
    }
    u = make(body.slice(0, lo) + marker);
  }
  const out = u.toString();
  // Defensive: never hand a non-https URL to openExternal (spec §4.4).
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

describe('submitFeedback', () => {
  beforeEach(() => post.mockReset());

  it('returns created on 201', async () => {
    post.mockResolvedValue({ issueNumber: 9, htmlUrl: 'https://x/9' });
    await expect(submitFeedback({ category: 'Bug', summary: 's', details: 'd', routePattern: '/', platform: 'browser' }))
      .resolves.toEqual({ outcome: 'created', issueNumber: 9, htmlUrl: 'https://x/9' });
  });

  it('maps a 422 to cannot-create', async () => {
    post.mockRejectedValue(new FakeApiError(422));
    await expect(submitFeedback({ category: 'Bug', summary: 's', details: 'd', routePattern: '/', platform: 'browser' }))
      .resolves.toEqual({ outcome: 'cannot-create' });
  });

  it('rethrows other errors (5xx/network)', async () => {
    post.mockRejectedValue(new FakeApiError(500));
    await expect(submitFeedback({ category: 'Bug', summary: 's', details: 'd', routePattern: '/', platform: 'browser' }))
      .rejects.toBeInstanceOf(FakeApiError);
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

// POSTs to /api/feedback. 201 → created; 422 (CannotCreate) → caller falls back to
// the prefilled link; anything else (5xx/network) rethrows for the retry path.
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

> Verify the exact `ApiError` export name/shape in `frontend/src/api/client.ts` and adjust if it differs (e.g. a `status` vs `statusCode` field).

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

This is the largest task; build it in TDD slices.

- [ ] **Step 1: Write failing tests (validation + states)**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const submitFeedback = vi.hoisted(() => vi.fn());
const openExternalSpy = vi.hoisted(() => vi.fn());
vi.mock('../../api/feedback', () => ({ submitFeedback }));

import { FeedbackDialog } from './FeedbackDialog';

function open(props: Partial<React.ComponentProps<typeof FeedbackDialog>> = {}) {
  return render(
    <FeedbackDialog open onClose={() => {}} authed routePattern="/inbox" {...props} />,
  );
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    submitFeedback.mockReset();
    openExternalSpy.mockReset();
    (window as unknown as { prism?: unknown }).prism = { openExternal: openExternalSpy };
  });

  it('disables submit until category, summary, and details are filled', async () => {
    open();
    const submit = screen.getByRole('button', { name: /send feedback/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/summary/i), 'It broke');
    await userEvent.type(screen.getByLabelText(/details/i), 'steps');
    expect(submit).toBeEnabled();
  });

  it('shows "Filed as #N" on a 201', async () => {
    submitFeedback.mockResolvedValue({ outcome: 'created', issueNumber: 12, htmlUrl: 'https://x/12' });
    open();
    await userEvent.type(screen.getByLabelText(/summary/i), 's');
    await userEvent.type(screen.getByLabelText(/details/i), 'd');
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByText(/filed as #12/i)).toBeInTheDocument();
  });

  it('offers the prefilled link on cannot-create and opens an https url', async () => {
    submitFeedback.mockResolvedValue({ outcome: 'cannot-create' });
    open();
    await userEvent.type(screen.getByLabelText(/summary/i), 's');
    await userEvent.type(screen.getByLabelText(/details/i), 'd');
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    const openBtn = await screen.findByRole('button', { name: /open on github/i });
    await userEvent.click(openBtn);
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
    expect(openExternalSpy.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/prpande\/PRism-feedback\/issues\/new/);
  });

  it('first-run (not authed) skips the API and opens the prefilled link directly', async () => {
    open({ authed: false });
    await userEvent.type(screen.getByLabelText(/summary/i), 's');
    await userEvent.type(screen.getByLabelText(/details/i), 'd');
    await userEvent.click(screen.getByRole('button', { name: /open on github/i }));
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  it('shows an error with Retry on a thrown (5xx) error', async () => {
    submitFeedback.mockRejectedValue(new Error('boom'));
    open();
    await userEvent.type(screen.getByLabelText(/summary/i), 's');
    await userEvent.type(screen.getByLabelText(/details/i), 'd');
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('warns not to paste secrets', () => {
    open();
    expect(screen.getByText(/don't include tokens, secrets/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/Feedback/FeedbackDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dialog**

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
```

Create `frontend/src/components/Feedback/FeedbackDialog.tsx`:

```tsx
import { useState } from 'react';
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
  | { kind: 'offer-link' } // CannotCreate or first-run
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
  routePattern: string;
}

function platform(): string {
  return typeof window.prism?.openExternal === 'function' ? 'desktop' : 'browser';
}

// Opens a URL externally: openExternal bridge when present, window.open fallback,
// error surfaced to the caller's catch (spec §4.4 — diverges from the anchor-based
// OpenInGitHubButton: this is imperative, so it implements both itself).
async function openExternal(url: string): Promise<void> {
  if (new URL(url).protocol !== 'https:') throw new Error('refusing non-https url');
  if (typeof window.prism?.openExternal === 'function') {
    const ok = await window.prism.openExternal(url);
    if (!ok) throw new Error('openExternal rejected the url');
    return;
  }
  window.open(url, '_blank', 'noreferrer');
}

export function FeedbackDialog({ open, onClose, authed, routePattern }: FeedbackDialogProps) {
  const [category, setCategory] = useState<Category>('Bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const canSubmit = category && summary.trim() && details.trim() && state.kind === 'idle';
  const linkOnly = !authed;
  const submitLabel = linkOnly ? 'Open on GitHub' : 'Send feedback';

  const prefilledUrl = () =>
    buildFeedbackIssueUrl({
      title: `[${category}] ${summary.trim()}`,
      body: `${details.trim()}\n\n---\nroute: ${routePattern}\nplatform: ${platform()}`,
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
    setState({ kind: 'in-flight' });
    try {
      const req: FeedbackRequest = {
        category,
        summary: summary.trim(),
        details: details.trim(),
        routePattern,
        platform: platform(),
      };
      const res = await submitFeedback(req);
      if (res.outcome === 'created') setState({ kind: 'success', issueNumber: res.issueNumber, htmlUrl: res.htmlUrl });
      else setState({ kind: 'offer-link' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  const title =
    state.kind === 'success'
      ? 'Feedback sent'
      : state.kind === 'offer-link' || state.kind === 'opened'
        ? 'Open on GitHub'
        : 'Send feedback';

  return (
    <Modal open={open} title={title} onClose={onClose} disableEscDismiss={state.kind === 'in-flight'}>
      {state.kind === 'success' ? (
        <div>
          <p>
            Filed as #{state.issueNumber}.{' '}
            <button type="button" className="btn btn-secondary" onClick={() => void openExternal(state.htmlUrl)}>
              Open in GitHub
            </button>
          </p>
          <div className={styles.footer}>
            <button type="button" className="btn btn-primary" data-modal-role="primary" onClick={onClose}>
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
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.form}>
          <SegmentedControl
            label="Feedback category"
            options={CATEGORIES}
            value={category}
            onChange={(v) => setCategory(v)}
            disabled={state.kind === 'in-flight'}
          />
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
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                data-modal-role="primary"
                disabled={!canSubmit}
                onClick={() => void onSubmit()}
              >
                {state.kind === 'in-flight' ? 'Sending…' : submitLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
```

> Confirm the real `Modal` import path/props from `frontend/src/components/Modal/Modal.tsx` and `SegmentedControl` from `frontend/src/components/controls/SegmentedControl.tsx` (both verified to exist). Adjust prop names (`disableEscDismiss`, `data-modal-role="primary"`) if they differ. The `.btn`/`.btn-primary` classes are the app's existing global button classes (used by SubmitDialog/ErrorModal).

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/Feedback/FeedbackDialog.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Feedback/
git commit -m "feat(#211): FeedbackDialog with API + prefilled-link fallback"
```

### Task 16: Wire the "Send feedback" triggers (HelpPage + welcome footer)

**Files:**
- Modify: `frontend/src/pages/HelpPage.tsx` (+ test)
- Modify: `frontend/src/pages/WelcomePage.tsx` (+ test)

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/pages/HelpPage.test.tsx`:

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

In `frontend/src/pages/HelpPage.tsx`, add dialog state and a button after the last section. The Help page is reached in authed and unauthed states, so derive `authed` from `useAuth`:

```tsx
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useLocation } from 'react-router-dom';
import { FeedbackDialog } from '../components/Feedback/FeedbackDialog';
```

Inside the component:

```tsx
  const { authState } = useAuth();
  const authed = Boolean(authState?.hasToken);
  const location = useLocation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
```

After the shortcuts `<section>`, before `</main>`:

```tsx
      <button type="button" className="btn btn-primary" onClick={() => setFeedbackOpen(true)}>
        Send feedback
      </button>
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        authed={authed}
        routePattern={location.pathname}
      />
```

> `routePattern` on the Help/Welcome pages is just the static path (`/help`, `/welcome`) — there's no `:param` route here, so passing `location.pathname` is already pattern-safe. (The `/pr/:owner/:repo/:number` concretization only matters when the dialog is opened from a PR-detail context, which is out of scope for this slice; if a future trigger lives there, pass the matched pattern.)

- [ ] **Step 4: Add the trigger to WelcomePage**

In `frontend/src/pages/WelcomePage.tsx`, replace the `Send feedback` stub `<span>` with a button + dialog (mirror the HelpPage wiring; `authed={false}` since `/welcome` is first-run by definition):

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

And before the closing element of the card, render:

```tsx
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        authed={false}
        routePattern="/welcome"
      />
```

Add a `.footerLink` button reset so it matches the link styling (it's already defined as a class; ensure `button.footerLink` has `border:none;background:none;cursor:pointer;font:inherit`):

```css
button.footerLink {
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
}
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

test('feedback dialog opens, validates, and offers a prefilled link', async ({ page }) => {
  await page.goto('/help');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const dialog = page.getByRole('dialog', { name: /send feedback/i });
  await expect(dialog).toBeVisible();

  // Submit disabled until filled.
  const submit = dialog.getByRole('button', { name: /send feedback|open on github/i });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/summary/i).fill('e2e summary');
  await dialog.getByLabel(/details/i).fill('e2e details');
  await expect(submit).toBeEnabled();
});
```

> If the e2e environment cannot reach real GitHub, stub `/api/feedback` (route interception) to return 422 and assert the offered-link button appears; mirror how sibling specs stub backend routes.

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
Expected: all green. (Run the .NET build/test from the repo root; run only one long build/test at a time.)

- [ ] **Step 2: Secrets scan** over the diff (no hardcoded tokens — the design ships none; the repo slug is public). Record the result in `## Proof`.

- [ ] **Step 3: Sync main, then ship via pr-autopilot**

Fetch + merge `origin/main`, then use `pr-autopilot`. This PR is **B2-gated** (GitHub write surface) *and* B1 (the dialog UI). Per the issue-resolution workflow, the B2 surface means the human gate is on the **approach** — but the approach was already gated at the spec/plan stage; the pre-PR re-check (re-read the diff vs the risk table) confirms no *additional* risk surface was touched. Drive to green-and-ready, then notify the human with the PR link, the `## Proof` section, and the B1 screenshots (the dialog states + `/help`). Human merges.

---

## Self-review

**Spec coverage** (each spec section → task):
- §3 `/help` route + entry points → Tasks 3, 4, 5.
- §4.1 host resolution / api.github.com client → Task 10 (named `github.com` client) + Task 15 (frontend `authed`/host gating: the dialog attempts the API only when `authed`; the host==github.com refinement is enforced by the backend always targeting api.github.com and a non-github.com PAT 401/404→CannotCreate→link, plus the frontend `authed` gate). **Coverage note:** the spec's explicit "skip API when `authState.host !== 'github.com'`" frontend guard is *partially* deferred — Task 15 gates on `authed` only. A GHES *authed* user would attempt the API (PAT 401/404 → CannotCreate → link), which is correct behavior but does send the GHES PAT to api.github.com once. **Fix during execution:** in Task 15, extend `linkOnly` to `!authed || host !== 'github.com'`, passing `host` from `useAuth()` into the dialog. Add this to the FeedbackDialog props + a test case. (Flagged here rather than silently — see also the deviation log.)
- §4.2 issue construction (title prefix, allowlisted body, version) → Tasks 9, 10, 11, 12.
- §4.3 user-PAT rationale → no code (design rationale).
- §4.4 prefilled-link (https-validated, truncation, openExternal divergence) → Tasks 13, 15.
- §4.5 slug constant + drift guard → Tasks 8, 13 (pinned-literal in both suites).
- §5 HelpPage + Header `?` + welcome wiring + FeedbackDialog states → Tasks 2, 4, 5, 15, 16.
- §6 endpoint + submitter + status mapping → Tasks 9, 10, 12.
- §8 error handling (403/404/422→CannotCreate, https guard) → Tasks 10, 12, 13, 15.
- §9 testing → tests in every task + Tasks 6, 17 (e2e).
- §10 phasing → PR1 / PR2 split.
- §11 deferrals → not implemented by design (D1/D2); D3 (no labels) honored in Task 10; D4 (build constant) in Tasks 8, 13.
- §12 ACs → covered; the cross-tier slug AC is the pinned-literal guard (deviation #3).

**Action item folded in:** Task 15 must add the `host !== 'github.com'` gate + prop + test (noted above) to fully satisfy §4.1. Add it as Step 6 of Task 15 during execution.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `FeedbackContent`/`FeedbackCreateResult`/`FeedbackOutcome` (Tasks 9, 10, 12) consistent; `IFeedbackSubmitter.CreateFeedbackIssueAsync` signature identical across interface (Task 9), impl (Task 10), and endpoint call (Task 12); frontend `FeedbackResult` (`'created'`/`'cannot-create'`) consistent across Tasks 14, 15; `FEEDBACK_REPO_SLUG`/`FeedbackRepo.Slug` both `"prpande/PRism-feedback"`.
