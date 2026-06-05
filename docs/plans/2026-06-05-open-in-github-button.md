# Open-in-GitHub Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Open in GitHub" control to the PR-detail header that opens the PR's web page (OS browser on desktop, new tab in browser), sourced from an authoritative backend `htmlUrl`, and fix the three hardcoded `github.com` sites as a consequence.

**Architecture:** The backend already fetches GitHub's GraphQL `url` (the HTML page URL, host-correct for GHES) but drops it; we extract it into a new nullable `HtmlUrl` on the `Pr` record. The frontend threads `htmlUrl` to a new `OpenInGitHubButton` (in `PrHeader`) and to the three existing link sites (`FilesTab→DiffPane→DiffTruncationBanner`, `SubmitDialog`). Desktop opening goes through a new, hardened `shell:open-external` IPC channel (sender guard + https-only predicate).

**Tech Stack:** C# (.NET, xUnit + FluentAssertions), React + TypeScript + Vite (vitest + Testing Library), Electron (`node --test`), Playwright e2e.

**Spec:** `docs/specs/2026-06-05-open-in-github-button-design.md`

**Worktree:** `D:/src/PRism-131-open-in-github` on branch `fix/131-open-in-github`. All commands below run from the worktree root.

**Spec correction folded in:** the spec describes `DiffPane` appending `/files#diff-…` to `prUrl`; the actual code only forwards `prUrl` to `DiffTruncationBanner`, which renders it as the PR-root "Open on github.com" link. There is no per-file deep-link append. Tasks reflect the real code.

**Pre-push gate (run once at the end, before pr-autopilot):** `.ai/docs/development-process.md` checklist — `cd frontend && npm run lint && npm run build`, `dotnet build --configuration Release`, `dotnet test`, `cd frontend && npm test`, desktop `npm run test:unit`. Prettier-check is in `npm run lint`; run `npx prettier --write` on new/changed frontend files before staging.

---

## Task 1: Backend — add `HtmlUrl` to the `Pr` record

**Files:**
- Modify: `PRism.Core.Contracts/Pr.cs`

- [ ] **Step 1: Add the trailing optional param + refresh the CA justification**

Replace the whole record with:

```csharp
using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Contracts;

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "AvatarUrl and HtmlUrl are raw URL strings from the GitHub API.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "AvatarUrl and HtmlUrl are raw URL strings from the GitHub API.")]
public sealed record Pr(
    PrReference Reference,
    string Title,
    string Body,
    string Author,
    string State,
    string HeadSha,
    string BaseSha,
    string HeadBranch,
    string BaseBranch,
    string Mergeability,
    string CiSummary,
    bool IsMerged,
    bool IsClosed,
    DateTimeOffset OpenedAt,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null,
    string? HtmlUrl = null);
```

`HtmlUrl` is a **trailing optional** param so every existing positional `new Pr(...)` call site keeps compiling (mirrors the `AvatarUrl` precedent).

- [ ] **Step 2: Verify it builds**

Run: `dotnet build PRism.Core.Contracts --configuration Release`
Expected: Build succeeded, 0 errors.

- [ ] **Step 3: Commit**

```bash
git add PRism.Core.Contracts/Pr.cs
git commit -m "feat(#131): add HtmlUrl to Pr record"
```

---

## Task 2: Backend — extract `HtmlUrl` in `ParsePr` (empty→null) + tests

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs:1001-1057` (`ParsePr`)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs`

- [ ] **Step 1: Write the failing tests**

In `GitHubReviewServicePrDetailTests.cs`, add a fixture variant **without** a `url` field and two facts. Add this constant after `PrDetailWithCapHitBody` (around line 99):

```csharp
    // Same shape as PrDetailGraphQLBody but with NO "url" field — exercises the
    // empty→null normalization in ParsePr.
    private const string PrDetailNoUrlBody = """
    {
      "data": {
        "repository": {
          "pullRequest": {
            "title": "No url here",
            "body": "",
            "state": "OPEN",
            "isDraft": false,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "headRefName": "h",
            "baseRefName": "main",
            "headRefOid": "h",
            "baseRefOid": "b",
            "author": { "login": "alice" },
            "createdAt": "2026-01-01T00:00:00Z",
            "closedAt": null,
            "mergedAt": null,
            "changedFiles": 0,
            "comments": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
            "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] },
            "timelineItems": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] }
          }
        }
      }
    }
    """;

    [Fact]
    public async Task GetPrDetailAsync_maps_url_to_HtmlUrl()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailGraphQLBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 42), CancellationToken.None);

        dto!.Pr.HtmlUrl.Should().Be("https://github.com/o/r/pull/42");
    }

    [Fact]
    public async Task GetPrDetailAsync_maps_absent_url_to_null_HtmlUrl()
    {
        var handler = new GraphQLPlusRestHandler { GraphQLBody = PrDetailNoUrlBody };

        var dto = await NewService(handler).GetPrDetailAsync(new PrReference("o", "r", 1), CancellationToken.None);

        dto!.Pr.HtmlUrl.Should().BeNull();
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "HtmlUrl"`
Expected: FAIL — `maps_url_to_HtmlUrl` reds (HtmlUrl is null because ParsePr never sets it). `maps_absent_url_to_null` may pass vacuously (HtmlUrl defaults null) — that's fine; it locks the behavior.

- [ ] **Step 3: Implement the extraction in `ParsePr`**

In `GitHubReviewService.cs`, inside `ParsePr`, add after the `AvatarUrl()` local function (after line 1018):

```csharp
        string? HtmlUrl()
        {
            var url = GetStr("url");
            return string.IsNullOrEmpty(url) ? null : url;
        }
```

Then add the argument to the `new Pr(...)` constructor (after the `AvatarUrl: AvatarUrl()` line, line 1056) — change the closing to:

```csharp
            AvatarUrl: AvatarUrl(),
            HtmlUrl: HtmlUrl());
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "HtmlUrl"`
Expected: PASS (both facts).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs
git commit -m "feat(#131): extract GraphQL url into Pr.HtmlUrl (empty->null)"
```

---

## Task 3: Frontend — add `htmlUrl` to the `PrDetailPr` type

**Files:**
- Modify: `frontend/src/api/types.ts:143-161`

- [ ] **Step 1: Add the field**

In the `PrDetailPr` interface, add after `avatarUrl?: string | null;` (line 148):

```typescript
  htmlUrl?: string | null;
```

- [ ] **Step 2: Verify type-checks**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(#131): add htmlUrl to PrDetailPr type"
```

---

## Task 4: Desktop — `isOpenableUrl` pure predicate + unit tests

**Files:**
- Create: `desktop/src/urls.ts`
- Test: `desktop/test/urls.unit.test.ts`

`isOpenableUrl` lives in its own module (not `main.ts`) because `main.ts` boots Electron on import — the `node --test` harness must import a side-effect-free module (same pattern as `src/platform.ts`).

- [ ] **Step 1: Write the failing test**

Create `desktop/test/urls.unit.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenableUrl } from "../src/urls";

test("isOpenableUrl accepts an https URL", () => {
  assert.equal(isOpenableUrl("https://github.com/o/r/pull/1"), true);
});

test("isOpenableUrl accepts uppercase HTTPS (URL normalizes the scheme)", () => {
  assert.equal(isOpenableUrl("HTTPS://github.com/o/r/pull/1"), true);
});

test("isOpenableUrl rejects http", () => {
  assert.equal(isOpenableUrl("http://github.com/o/r/pull/1"), false);
});

test("isOpenableUrl rejects file:", () => {
  assert.equal(isOpenableUrl("file:///etc/passwd"), false);
});

test("isOpenableUrl rejects javascript:", () => {
  assert.equal(isOpenableUrl("javascript:alert(1)"), false);
});

test("isOpenableUrl rejects data:", () => {
  assert.equal(isOpenableUrl("data:text/html,<script>alert(1)</script>"), false);
});

test("isOpenableUrl rejects malformed input", () => {
  assert.equal(isOpenableUrl("not a url"), false);
  assert.equal(isOpenableUrl(""), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && npm run test:unit`
Expected: FAIL — cannot find module `../src/urls`.

- [ ] **Step 3: Implement the predicate**

Create `desktop/src/urls.ts`:

```typescript
// Pure URL-safety predicate for the shell:open-external IPC channel. Kept in its
// own module (no Electron imports) so it is unit-testable under `node --test`
// without booting the app. shell.openExternal hands the string to the OS shell,
// so we allow ONLY https: — rejecting file:, javascript:, data:, smb:, etc.
export function isOpenableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd desktop && npm run test:unit`
Expected: PASS (all urls + existing platform/ports/sidecar tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/urls.ts desktop/test/urls.unit.test.ts
git commit -m "feat(#131): add https-only isOpenableUrl predicate for desktop external-open"
```

---

## Task 5: Desktop — `shell:open-external` IPC handler

**Files:**
- Modify: `desktop/src/main.ts` (imports line 1; handler block after line 59)

- [ ] **Step 1: Add the `shell` import + `isOpenableUrl` import**

Change line 1 and add the urls import:

```typescript
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { startSidecar, Sidecar } from "./sidecar";
import { sidecarBinaryName } from "./platform";
import { isOpenableUrl } from "./urls";
```

- [ ] **Step 2: Register the handler (sender guard FIRST, never throws)**

Immediately after the `window:is-maximized` handler (after line 59, before `app.whenReady()`), add:

```typescript
  // Open an external URL in the OS browser. shell.openExternal is security-
  // sensitive, so: (1) only the main window's renderer may call (fromMainWindow),
  // (2) only https: URLs pass (isOpenableUrl rejects file:/javascript:/data:/…),
  // (3) the handler never throws to the renderer — returns true on success,
  // false on a rejected URL or a thrown open.
  ipcMain.handle("shell:open-external", async (e, url: string) => {
    if (!fromMainWindow(e)) return false;
    if (typeof url !== "string" || !isOpenableUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
```

- [ ] **Step 3: Verify the desktop build compiles**

Run: `cd desktop && npm run build`
Expected: tsc succeeds, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main.ts
git commit -m "feat(#131): add hardened shell:open-external IPC handler"
```

---

## Task 6: Desktop — preload bridge + `shell.d.ts` type

**Files:**
- Modify: `desktop/src/preload.ts`
- Modify: `frontend/src/types/shell.d.ts`

- [ ] **Step 1: Add `openExternal` to the preload bridge**

In `desktop/src/preload.ts`, inside the `exposeInMainWorld("prism", {...})` object, add a top-level method (sibling of `windowControls`, after line 19 `platform,`):

```typescript
  openExternal: async (url: string): Promise<boolean> => {
    const ok: boolean = await ipcRenderer.invoke("shell:open-external", url);
    // Observability: a false means the URL was rejected or the OS open threw.
    // On the real data path the URL is always an authoritative GitHub https URL,
    // so this fires only on a misconfiguration or a stray caller. Message is a
    // URL + flag — no token/PII content.
    if (!ok) console.warn("prism.openExternal: rejected", url);
    return ok;
  },
```

- [ ] **Step 2: Add the type to `PrismApi`**

In `frontend/src/types/shell.d.ts`, inside `interface PrismApi`, add after `platform: string;` (line 23):

```typescript
    /** Open an external https URL in the OS browser. Resolves false if the URL
     *  was rejected (non-https / malformed) or the OS open failed. */
    openExternal(url: string): Promise<boolean>;
```

- [ ] **Step 3: Verify both compile**

Run: `cd desktop && npm run build && cd ../frontend && npx tsc --noEmit`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/preload.ts frontend/src/types/shell.d.ts
git commit -m "feat(#131): expose prism.openExternal bridge + type"
```

---

## Task 7: Frontend — `OpenInGitHubButton` component + tests

**Files:**
- Create: `frontend/src/components/PrDetail/OpenInGitHubButton.tsx`
- Test: `frontend/__tests__/OpenInGitHubButton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/OpenInGitHubButton.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenInGitHubButton } from '../src/components/PrDetail/OpenInGitHubButton';

const HREF = 'https://github.example.com/acme/api/pull/123';

afterEach(() => {
  delete (window as unknown as { prism?: unknown }).prism;
  vi.restoreAllMocks();
});

describe('OpenInGitHubButton', () => {
  it('renders nothing when href is absent', () => {
    const { container } = render(<OpenInGitHubButton href={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an anchor with the host-correct href in the browser case', () => {
    render(<OpenInGitHubButton href={HREF} />);
    const link = screen.getByTestId('open-in-github-button');
    expect(link).toHaveAttribute('href', HREF);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveTextContent('Open in GitHub');
  });

  it('intercepts the click and calls openExternal on desktop', () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { isDesktop: true, openExternal };
    render(<OpenInGitHubButton href={HREF} />);
    const link = screen.getByTestId('open-in-github-button');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(evt);
    expect(openExternal).toHaveBeenCalledWith(HREF);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('does NOT intercept when isDesktop but openExternal is missing (partial build)', () => {
    (window as unknown as { prism: unknown }).prism = { isDesktop: true };
    render(<OpenInGitHubButton href={HREF} />);
    const link = screen.getByTestId('open-in-github-button');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    // Must not throw, and must NOT suppress native navigation.
    expect(() => link.dispatchEvent(evt)).not.toThrow();
    expect(evt.defaultPrevented).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- OpenInGitHubButton`
Expected: FAIL — cannot resolve the component module.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/PrDetail/OpenInGitHubButton.tsx`:

```tsx
// "Open in GitHub" escape-hatch link in the PR-detail header .prActions.
// - href is the authoritative PrDetailPr.htmlUrl (host-correct for GHES).
// - Absent href → render nothing (no dead control).
// - Desktop: when the bridge method exists, intercept and open in the OS browser.
//   Gate on the METHOD's presence, not window.prism.isDesktop: an older/partial
//   desktop build can expose isDesktop:true with no openExternal, and gating on
//   isDesktop would preventDefault() then call undefined → a dead control.
// - Browser (or partial desktop): the native target="_blank" opens a new tab.
interface OpenInGitHubButtonProps {
  href?: string | null;
}

function GitHubMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function OpenInGitHubButton({ href }: OpenInGitHubButtonProps) {
  if (!href) return null;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (typeof window.prism?.openExternal === 'function') {
      e.preventDefault();
      void window.prism.openExternal(href);
    }
  };

  return (
    <a
      className="btn btn-secondary open-in-github-button"
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid="open-in-github-button"
      onClick={handleClick}
    >
      <GitHubMark />
      Open in GitHub
    </a>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test -- OpenInGitHubButton`
Expected: PASS (4 tests).

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/OpenInGitHubButton.tsx __tests__/OpenInGitHubButton.test.tsx && cd ..
git add frontend/src/components/PrDetail/OpenInGitHubButton.tsx frontend/__tests__/OpenInGitHubButton.test.tsx
git commit -m "feat(#131): OpenInGitHubButton component (method-presence-gated desktop intercept)"
```

---

## Task 8: Frontend — wire the button into `PrHeader` + `PrDetailView`

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (props ~81-120, body ~145, render ~445, SubmitDialog render ~476)
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx:253-276`
- Test: `frontend/__tests__/PrHeader.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `frontend/__tests__/PrHeader.test.tsx`, add a describe block (after the existing imports/baseProps; reuse the existing render helper — find how existing tests render PrHeader, typically a `renderHeader(props)` helper or `rtlRender(<Providers><PrHeader .../></Providers>)`). Add:

```tsx
describe('#131 Open in GitHub button', () => {
  it('renders the button when htmlUrl is present', () => {
    rtlRender(
      <ToastProvider>
        <AskAiDrawerProvider>
          <PrHeader {...baseProps} htmlUrl="https://github.example.com/octocat/hello/pull/42" />
          <ToastContainer />
        </AskAiDrawerProvider>
      </ToastProvider>,
    );
    const link = screen.getByTestId('open-in-github-button');
    expect(link).toHaveAttribute('href', 'https://github.example.com/octocat/hello/pull/42');
  });

  it('renders nothing for the button when htmlUrl is absent', () => {
    rtlRender(
      <ToastProvider>
        <AskAiDrawerProvider>
          <PrHeader {...baseProps} />
          <ToastContainer />
        </AskAiDrawerProvider>
      </ToastProvider>,
    );
    expect(screen.queryByTestId('open-in-github-button')).toBeNull();
  });
});
```

(If the existing tests use a local `renderHeader(props)` helper, call that instead of inlining the providers — match the file's established pattern.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- PrHeader`
Expected: FAIL — `htmlUrl` not a prop / button not rendered.

- [ ] **Step 3: Add the prop, import, render, and DEV warn**

In `PrHeader.tsx`:

(a) Add to `PrHeaderProps` (after `closedAt?: string | null;`, line 119):

```typescript
  // #131 — authoritative PR web URL (PrDetailPr.htmlUrl). Absent → no button.
  htmlUrl?: string | null;
```

(b) Add `htmlUrl` to the destructured params (after `closedAt,`, line 144):

```typescript
  htmlUrl,
```

(c) Add the import near the other PrDetail imports at the top of the file:

```typescript
import { OpenInGitHubButton } from './OpenInGitHubButton';
```

(d) Ensure `useEffect` is imported from `'react'` (add it to the existing React import if absent), then add this effect inside the component body (near the top, after the existing hooks ~line 148):

```typescript
  // Dev-only signal: if a loaded PR (title present) has no htmlUrl, the escape-
  // hatch links silently disappear — surface that so a ParsePr/GraphQL-shape
  // regression is detectable. PrHeader is the always-rendered common ancestor of
  // all three link sites on the detail page.
  useEffect(() => {
    if (import.meta.env.DEV && title && !htmlUrl) {
      // eslint-disable-next-line no-console
      console.warn('PrHeader: PR detail rendered without htmlUrl — Open-in-GitHub links hidden', reference);
    }
  }, [title, htmlUrl, reference]);
```

(e) Render the button after `<AskAiButton onClick={toggleAskAi} />` (line 445):

```tsx
          <AskAiButton onClick={toggleAskAi} />
          <OpenInGitHubButton href={htmlUrl} />
```

(f) Pass `htmlUrl` to the `<SubmitDialog>` (add inside its props, e.g. after `reference={reference}`, line 478) — used in Task 10:

```tsx
          htmlUrl={htmlUrl}
```

- [ ] **Step 4: Pass `htmlUrl` from `PrDetailView`**

In `PrDetailView.tsx`, add to the `<PrHeader ... />` props (after `avatarUrl={data?.pr.avatarUrl}`, line 257):

```tsx
        htmlUrl={data?.pr.htmlUrl}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && npm test -- PrHeader`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/PrHeader.tsx src/components/PrDetail/PrDetailView.tsx __tests__/PrHeader.test.tsx && cd ..
git add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrDetailView.tsx frontend/__tests__/PrHeader.test.tsx
git commit -m "feat(#131): render OpenInGitHubButton in PrHeader + thread htmlUrl"
```

---

## Task 9: Frontend — FilesTab → DiffPane → DiffTruncationBanner host-correctness

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:147,531`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:112,166,676`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx`
- Test: `frontend/__tests__/DiffTruncationBanner.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/__tests__/DiffTruncationBanner.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffTruncationBanner } from '../src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner';

describe('DiffTruncationBanner', () => {
  it('links to the host-correct prUrl with a host-agnostic label', () => {
    render(<DiffTruncationBanner prUrl="https://github.example.com/acme/api/pull/123" />);
    const link = screen.getByRole('link', { name: /open on github/i });
    expect(link).toHaveAttribute('href', 'https://github.example.com/acme/api/pull/123');
    expect(link).toHaveTextContent('Open on GitHub');
    expect(screen.queryByText(/github\.com/)).toBeNull();
  });

  it('omits the link when prUrl is absent', () => {
    render(<DiffTruncationBanner prUrl={undefined} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('diff-truncation-banner')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- DiffTruncationBanner`
Expected: FAIL — label is "Open on github.com"; `prUrl` is required (undefined case type-errors / renders broken link).

- [ ] **Step 3: Update `DiffTruncationBanner` (optional prUrl, omit, relabel)**

Replace `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx`:

```tsx
import styles from './DiffTruncationBanner.module.css';

export interface DiffTruncationBannerProps {
  // Authoritative PR web URL (PrDetailPr.htmlUrl). Absent → omit the link.
  prUrl?: string;
}

export function DiffTruncationBanner({ prUrl }: DiffTruncationBannerProps) {
  return (
    <div
      className={`diff-truncation-banner banner banner-warning ${styles.diffTruncationBanner}`}
      role="status"
      data-testid="diff-truncation-banner"
    >
      <p>
        PRism shows GitHub&apos;s first portion of this diff. Full-diff support is on the roadmap.{' '}
        {prUrl && (
          <a href={prUrl} target="_blank" rel="noopener noreferrer">
            Open on GitHub
          </a>
        )}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Thread the optional prUrl through `DiffPane`**

In `DiffPane.tsx`:
- Line 112: change `prUrl: string;` → `prUrl?: string;`
- Line 676 stays `<DiffTruncationBanner prUrl={prUrl} />` (now optional end-to-end).

- [ ] **Step 5: Source the URL from `htmlUrl` in `FilesTab`**

In `FilesTab.tsx`:
- Replace line 147:

```typescript
  const prUrl = prDetail.pr.htmlUrl ?? undefined;
```

- Line 531 stays `prUrl={prUrl}` (now `string | undefined`).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd frontend && npm test -- DiffTruncationBanner && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 7: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/FilesTab/FilesTab.tsx src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx __tests__/DiffTruncationBanner.test.tsx && cd ..
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx frontend/__tests__/DiffTruncationBanner.test.tsx
git commit -m "feat(#131): source diff-truncation link from htmlUrl, relabel + omit on absent"
```

---

## Task 10: Frontend — `SubmitDialog` host-correct "View on GitHub"

**Files:**
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx` (Props ~41-91, const ~317, link ~518)
- Test: `frontend/__tests__/SubmitDialog.test.tsx` (add a case; create file if none exists)

`PrHeader` already passes `htmlUrl={htmlUrl}` to `<SubmitDialog>` (Task 8 step 3f).

- [ ] **Step 1: Write the failing test**

If a `SubmitDialog` test file exists, add this case; otherwise create `frontend/__tests__/SubmitDialog.test.tsx` with the file's standard provider setup (model it on an existing dialog test). The assertion:

```tsx
// within a test that renders SubmitDialog in its `success` state:
it('View on GitHub link uses htmlUrl, not a hardcoded host', () => {
  // ...render SubmitDialog with submitState success + htmlUrl set to a GHES URL...
  const link = screen.getByRole('link', { name: /view on github/i });
  expect(link).toHaveAttribute('href', 'https://github.example.com/acme/api/pull/123');
});
```

(Reaching the success state requires `submitState={{ kind: 'succeeded', ... }}` — match the `SubmitState` success shape used elsewhere in the suite. If standing up the success state is disproportionate, assert at minimum that the `prUrl`-derived link prefers `htmlUrl` via a focused render; do not assert against a hardcoded `github.com`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- SubmitDialog`
Expected: FAIL — link still uses hardcoded `https://github.com/...`.

- [ ] **Step 3: Add the prop + use it + omit on absent**

In `SubmitDialog.tsx`:

(a) Add to `Props` (after `reference: PrReference;`, line 43):

```typescript
  // #131 — authoritative PR web URL (PrDetailPr.htmlUrl). Absent → omit the
  // "View on GitHub" link in the success footer.
  htmlUrl?: string;
```

(b) Destructure `htmlUrl` where the other props are pulled from `props` (in the `const { open, ... } = props;` block near line 93).

(c) Replace line 317:

```typescript
  const prUrl = htmlUrl;
```

(d) Replace the success-footer link (lines 516-525) to omit when absent:

```tsx
          {success && (
            <>
              {prUrl && (
                <a className="btn btn-secondary" href={prUrl} target="_blank" rel="noreferrer">
                  View on GitHub →
                </a>
              )}
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </>
          )}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npm test -- SubmitDialog && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && npx prettier --write src/components/PrDetail/SubmitDialog/SubmitDialog.tsx __tests__/SubmitDialog.test.tsx && cd ..
git add frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx frontend/__tests__/SubmitDialog.test.tsx
git commit -m "feat(#131): SubmitDialog View-on-GitHub uses htmlUrl, omits on absent"
```

---

## Task 11: Playwright e2e — Open-in-GitHub control present with href

**Files:**
- Locate + modify: the fake PR-detail fixture so the scenario PR (`acme/api/123`) carries an `HtmlUrl` (else the button hides and the e2e can't assert it).
- Create: `frontend/e2e/open-in-github.spec.ts`

- [ ] **Step 1: Populate `HtmlUrl` on the fake scenario PR**

Find where the fake review service builds the `acme/api/123` `Pr`:

Run: `grep -rn "new Pr(" PRism.Web/TestHooks tests/PRism.Web.Tests/TestHelpers`

In the fake that serves PR detail (e.g. `PRism.Web/TestHooks/FakePrReader.cs` or `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs` — whichever builds the scenario PR returned for `acme/api/123`), set `HtmlUrl: "https://github.com/acme/api/pull/123"` on that `Pr` (add the named arg to its constructor). Keep the existing host so the e2e assertion is stable.

- [ ] **Step 2: Write the e2e spec**

Create `frontend/e2e/open-in-github.spec.ts`:

```typescript
// frontend/e2e/open-in-github.spec.ts
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

const VIEWPORT = { width: 1440, height: 900 };

test.describe('#131 Open in GitHub', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-diff"]').waitFor();
  });

  test('header shows an Open-in-GitHub link to the PR web page', async ({ page }) => {
    const link = page.locator('[data-testid="open-in-github-button"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/Open in GitHub/);
    await expect(link).toHaveAttribute('href', /\/acme\/api\/pull\/123$/);
    await expect(link).toHaveAttribute('target', '_blank');
  });
});
```

- [ ] **Step 3: Run the e2e**

Run: `cd frontend && npx playwright test open-in-github`
Expected: PASS. (If `setupAndOpenScenarioPr`/`resetBackendState` signatures differ from `pr-header-collapse.spec.ts`, match that file — it is the reference PR-detail e2e.)

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/open-in-github.spec.ts PRism.Web/TestHooks tests/PRism.Web.Tests/TestHelpers
git commit -m "test(#131): e2e asserts Open-in-GitHub control + href; fake PR carries HtmlUrl"
```

---

## Task 12: Full pre-push checklist + final commit

- [ ] **Step 1: Run the complete gate (one long command at a time)**

```bash
dotnet build --configuration Release
dotnet test
cd frontend && npm run lint && npm run build && npm test && cd ..
cd desktop && npm run build && npm run test:unit && cd ..
cd frontend && npx playwright test open-in-github pr-header-collapse && cd ..
```

Expected: all green. Fix any failure before proceeding. (Run only one build/test command at a time per the repo rule.)

- [ ] **Step 2: Sync main**

```bash
git fetch origin
git merge origin/main
```

Re-run the gate if the merge brought changes. Resolve conflicts if any.

- [ ] **Step 3: Hand off to pr-autopilot**

Implementation complete — proceed to the B1 visual gate (screenshots of the button in light + dark, browser + desktop intercept) and `pr-autopilot`. Do NOT merge: #131 is gated B1, so it stops at green-and-ready for the human visual assert.

---

## Self-Review (author checklist — completed)

**Spec coverage:**
- D1 authoritative htmlUrl → Tasks 1, 2 (backend), 3 (frontend type). ✓
- D1 three hardcoded sites → Task 9 (FilesTab/DiffPane/DiffTruncationBanner), Task 10 (SubmitDialog). Button site = Tasks 7-8. ✓
- D1 null-not-empty → Task 2 (empty→null + test). ✓
- D2 component + method-presence gate + omit + DEV warn → Tasks 7 (component+partial-build test), 8 (warn). ✓
- D2 placement far-right after Ask-AI → Task 8 step 3e. ✓
- D3 https-only predicate + sender guard + Promise<boolean> + preload warn → Tasks 4, 5, 6. ✓
- Acceptance criteria → all mapped to tasks/tests; partial-build AC = Task 7 test 4; sender-guard/https = Tasks 4-5; absent-omit = Tasks 7/9/10. ✓
- Test plan (backend xUnit, vitest, node --test, Playwright) → Tasks 2, 7-10, 4, 11. ✓

**Placeholder scan:** Task 10 step 1 and Task 11 step 1 carry conditional "match the existing harness" guidance (success-state shape; fixture location) because those depend on file specifics the executor confirms by grep — concrete assertions are given; not open-ended TODOs. All code steps show real code.

**Type consistency:** `htmlUrl?: string | null` (frontend type/PrHeader/PrDetailView) vs `htmlUrl?: string` (component/SubmitDialog props) — the component takes `string | null | undefined` via `href?: string | null` and the `!href` guard absorbs null; SubmitDialog/DiffPane receive a possibly-undefined value (PrHeader passes the `string | null` through; `prUrl && (...)` / `!href` guards handle null). `prUrl?: string` on DiffPane/Banner accepts `undefined`; FilesTab maps `htmlUrl ?? undefined`. `Pr.HtmlUrl` (C#) ↔ `htmlUrl` (TS) ↔ `openExternal: Promise<boolean>` consistent across preload/type/handler. ✓
