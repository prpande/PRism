# Open-in-GitHub button on the PR detail page — design

**Issue:** [#131](https://github.com/prpande/PRism/issues/131) · **Tier:** T3 · **Risk:** gated — B1 (UI) + B2 (desktop sidecar / security)
· **Area:** `area:pr-detail`, `area:desktop` · **Milestone:** Phase 3 — Medium UX & Theming

## Problem

There is no way to jump from a PR open in PRism to that PR's GitHub web page, so a
reviewer who needs an action PRism doesn't offer (merge, request changes from the
web UI, edit labels, etc.) has no path out. Add an "Open in GitHub" control on the
PR detail page.

Two latent defects sit underneath the feature:

1. **No web URL on the detail PR.** The detail DTO (`Pr` /
   `PrDetailDto`) carries no html/web URL. The GitHub GraphQL query that builds it
   *already requests* `url`, but `GitHubReviewService.ParsePr` never extracts it.
2. **Hardcoded `github.com`.** Two frontend sites build GitHub URLs with a
   hardcoded host — `FilesTab.tsx:147` (root URL handed to `DiffPane` for per-file
   deep-links) and `SubmitDialog.tsx:317` ("View on GitHub" success link). Both
   break on GitHub Enterprise (GHES) hosts.

## Decisions

### D1 — The URL is authoritative, sourced from the backend

Add a nullable `HtmlUrl` to the detail `Pr` and extract `url` from the existing
GraphQL response in `ParsePr`. GraphQL `PullRequest.url` **is** the HTML page URL
(`https://<host>/<owner>/<repo>/pull/<n>`) and carries the configured host, so it
is **GHES-correct by construction** with zero string-building.

The frontend `Pr` type gains `htmlUrl?: string`. The new button, *and* the two
hardcoded sites, consume `htmlUrl`. `DiffPane`'s per-file links
(`${prUrl}/files#diff-…`) append to it unchanged. This removes both hardcoded
`github.com` strings as a natural consequence rather than papering over them.

**Rejected — frontend host-builder (`buildPrUrl(host, ref)`).** A util reading
`host` from preferences and constructing the URL needs no backend change, but it
re-derives what GitHub already tells us, owns fiddly host normalization (scheme
prefix, trailing slash, GHES path quirks), and is **not authoritative** — if our
stored host string ever drifts from GitHub's real URL, every link breaks silently.
The authoritative `url` is already on the wire; not using it is the worse trade.

**Rejected — hybrid (backend `htmlUrl` for the button, frontend builder
elsewhere).** Two URL-source mechanisms to keep consistent; the worst option for
maintainability.

### D2 — One component, desktop-intercept pattern

A new `OpenInGitHubButton` takes `href` (the `htmlUrl`) and renders an
`<a href={href} target="_blank" rel="noreferrer">` styled to match the existing
`.prActions` buttons, with a GitHub icon **and** the text label "Open in GitHub"
(label chosen over icon-only for discoverability; final look is the B1 visual
gate).

- **Desktop**: when `window.prism?.isDesktop`, `onClick` calls `e.preventDefault()`
  then `window.prism.openExternal(href)` so the link opens in the OS browser, not
  inside the Electron window. Keeping it an anchor (not a bare `<button>`) means
  right-click → *Copy link* still works, and the control degrades to a normal link
  if the bridge is ever absent.
- **Browser**: the anchor's native `target="_blank"` opens a new tab; no JS path.
- **Graceful absence**: if `htmlUrl` is null/absent, render **nothing** — no dead
  control.

### D3 — Desktop bridge: https-only validation (the B2 surface)

`shell.openExternal` hands a string to the OS shell; unvalidated it is a known
footgun (`file://`, `javascript:`, `smb://`, …). The fix is a **protocol
allowlist**:

- **`desktop/src/main.ts`**: `import { shell }`; add
  `ipcMain.handle('shell:open-external', …)`. The validation is a **pure exported
  function** `isOpenableUrl(url: string): boolean` returning
  `new URL(url).protocol === 'https:'` (wrapped in `try/catch` so a malformed URL
  returns `false`). The handler opens via `shell.openExternal` only when
  `isOpenableUrl` passes, and is a no-op (returns `false`) otherwise. Extracting
  the predicate keeps it unit-testable under `node --test` without launching
  Electron.
- **`desktop/src/preload.ts`**: add `openExternal(url): Promise<void>` to the
  `contextBridge`, invoking `ipcRenderer.invoke('shell:open-external', url)`.
- **`frontend/src/types/shell.d.ts`**: add
  `openExternal(url: string): Promise<void>` to `PrismApi`.

**Rejected — protocol + host allowlist (require URL host == configured GitHub
host).** Tightest, but `main.ts` does not know the configured host (it lives in
backend config / frontend preferences), so this drags host config across the
sidecar seam for marginal gain: the URL is already GitHub-authoritative (D1), so
host-pinning guards against essentially nothing the protocol check doesn't. Not
worth the new coupling.

## Acceptance criteria

- [ ] An "Open in GitHub" control (GitHub icon + label) appears in the PR-detail
  header `.prActions` and opens that PR's correct GitHub web page.
- [ ] Works for **GHES / enterprise hosts** — the URL carries the configured host
  (authoritative `htmlUrl`), with no hardcoded `github.com` anywhere on the path.
- [ ] **Desktop**: the link opens in the **OS browser**, not inside the Electron
  window. **Browser build**: opens in a **new tab**.
- [ ] The desktop bridge **refuses** non-`https:` URLs (`http:`, `file:`,
  `javascript:`, malformed) — they do not reach `shell.openExternal`.
- [ ] The two previously-hardcoded sites (`FilesTab` diff deep-links,
  `SubmitDialog` "View on GitHub") now resolve via the authoritative host.
- [ ] When `htmlUrl` is absent, the control renders nothing (no dead button) and
  the page is otherwise unaffected.

## Test plan

Non-bug enhancement → tests authored test-first (red → green within the PR), no
red-on-main requirement.

- **Backend (xUnit)**: extend the `ParsePr` mapping coverage to assert
  `url` → `HtmlUrl`, including the null/absent case.
- **Frontend (vitest)**:
  - `OpenInGitHubButton`: renders an anchor with the correct `href`,
    `target="_blank"`, `rel="noreferrer"` in the **browser** case; in the
    **desktop** case (mock `window.prism.isDesktop = true` + spy
    `openExternal`) the click calls `openExternal(href)` and the spied navigation
    is suppressed (`preventDefault`).
  - `PrHeader`: renders the control when `htmlUrl` is present; renders nothing
    when absent.
- **Desktop (`node --test`)**: `isOpenableUrl` accepts `https:`, rejects `http:`,
  `file:`, `javascript:`, and malformed input.
- **Playwright e2e**: on PR detail, the "Open in GitHub" control is present with
  the expected `href`. Required by the standing wire-shape rule (a new DTO field
  with frontend consumers must be exercised end-to-end, not just unit-mocked).

## Risk classification

**Gated — B1 + B2.**

- **B1 (UI-visual)**: a new visible control in `.prActions`; placement, icon, and
  fit alongside Submit/Ask-AI need a human eyeball. `area:pr-detail`.
- **B2 (desktop sidecar / security surface)**: introduces a new IPC channel and a
  `contextBridge` method, and calls `shell.openExternal` — an Electron
  security-sensitive API. `area:desktop`. Mitigated by the https-only predicate
  (D3); still gated because the *approach* on this surface warrants human review.

Because B2 fires the gate **early** (on the approach), the human reviews this spec
before any plan or code. The B1 eyeball-assert happens later, at green-and-ready.

## Scope

- **In:** `HtmlUrl` on `Pr` + `ParsePr` extraction; `htmlUrl` on the frontend `Pr`
  type and its plumbing to `PrHeader`; the `OpenInGitHubButton` component;
  consuming `htmlUrl` at the two hardcoded sites; the desktop
  `shell:open-external` IPC + preload bridge + `isOpenableUrl` predicate +
  `shell.d.ts` type; the tests above.
- **Out (YAGNI for #131):** a copy-link affordance; a dropdown of multiple GitHub
  actions; opening non-PR GitHub pages; threading the configured host into the
  Electron main process (rejected in D3); reworking the `.prActions` toolbar
  density (that is #185).

## Plan-time verifications (carried into writing-plans)

- **`Pr` record shape**: confirm whether `Pr` is a positional record before
  choosing how to add `HtmlUrl` — trailing `string? HtmlUrl = null` positional
  param vs `init` property — to avoid breaking existing constructors/tests.
- **Consumer reach**: confirm `FilesTab` and `SubmitDialog` can reach the `Pr`
  object (via `usePrDetail` data) for `htmlUrl`; if `SubmitDialog` only has
  `reference`, thread `htmlUrl` in as a prop rather than reconstructing.
- **GraphQL `url` presence**: confirm `url` is populated for the PR-detail query
  path in both open and merged/closed states.
