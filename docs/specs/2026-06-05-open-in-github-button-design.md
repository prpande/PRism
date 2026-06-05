# Open-in-GitHub button on the PR detail page — design

**Issue:** [#131](https://github.com/prpande/PRism/issues/131) · **Tier:** T3 · **Risk:** gated — B1 (UI) + B2 (desktop sidecar / security)
· **Area:** `area:pr-detail`, `area:desktop` · **Milestone:** Phase 3 — Medium UX & Theming

## Problem

There is no way to jump from a PR open in PRism to that PR's GitHub web page, so a
reviewer who needs an action PRism doesn't offer (merge, request changes from the
web UI, edit labels, etc.) has no path out. Add an "Open in GitHub" control on the
PR detail page.

Two latent defects sit underneath the feature:

1. **No web URL on the detail PR.** The detail DTO (`Pr` / `PrDetailDto`) carries
   no html/web URL. The GitHub GraphQL query that builds it *already requests*
   `url`, but `GitHubReviewService.ParsePr` never extracts it.
2. **Hardcoded `github.com`.** Three frontend sites bake in the host and break on
   GitHub Enterprise (GHES):
   - `FilesTab.tsx:147` — builds the PR root URL, handed to `DiffPane` as a
     `prUrl: string` prop for per-file deep-links (`${prUrl}/files#diff-…`).
   - `DiffPane` forwards that same `prUrl` to `DiffTruncationBanner.tsx`, which
     renders it as a **visible link labelled "Open on github.com"** — so on GHES
     not only is the host wrong, the label *names the wrong host* to the user.
   - `SubmitDialog.tsx:317` — the "View on GitHub" success-state link.

## Decisions

### D1 — The URL is authoritative, sourced from the backend

Add a nullable `HtmlUrl` to the detail `Pr` and extract `url` from the existing
GraphQL response in `ParsePr`. GraphQL `PullRequest.url` **is** the HTML page URL
(`https://<host>/<owner>/<repo>/pull/<n>`); PRism already resolves the GraphQL
endpoint per-host (`HostUrlResolver.GraphQlEndpoint(_host)`), so the returned `url`
carries the configured GHES host — **GHES-correct by construction**, zero
string-building.

**Null, not empty.** `GetStr("url")` returns `""` for an absent field, not null.
`ParsePr` must normalise: `HtmlUrl = string.IsNullOrEmpty(url) ? null : url`, so the
frontend's `htmlUrl?: string` optionality is meaningful and an absent value can't
masquerade as a same-origin relative link. (In practice GraphQL `PullRequest.url`
is a non-null `URI!`, so absence shouldn't occur — this is defensive correctness,
not an expected path.)

**Consumers.** The frontend `PrDetailPr` type (`api/types.ts`, *not* a type named
`Pr`) gains `htmlUrl?: string`. Consuming it is **deliberate plumbing, not a free
byproduct** — `PrDetailView` has `prDetail.pr`, but the downstream consumers are
flattened-prop components that do not receive the `Pr` object:

- **Button:** `PrDetailView → PrHeader` gains an `htmlUrl?: string` prop; `PrHeader`
  renders the control.
- **FilesTab chain:** `FilesTab` reads `prDetail.pr.htmlUrl` and threads it through
  the existing `prUrl` prop chain `FilesTab → DiffPane → DiffTruncationBanner`
  (three components today carry the pre-computed string). The
  `/files#diff-…` suffix `DiffPane` appends stays a **frontend convention** (the
  backend does not vend per-file deep-links); a test must cover the appended URL
  against a non-`github.com` GHES base.
- **SubmitDialog:** receives **only** `reference` today (no `Pr`). Removing its
  hardcode requires a **new `htmlUrl?` prop** threaded from `PrHeader` — counted as
  in-scope plumbing.

This removes all three hardcoded `github.com` strings (and corrects the
`DiffTruncationBanner` label, below) by routing every site through the one
authoritative field.

**Rejected — frontend host-builder (`buildPrUrl(host, ref)`).** A util reading
`host` from preferences and constructing the URL needs no backend change, but it
re-derives what GitHub already tells us, owns fiddly host normalization (scheme
prefix, trailing slash, GHES path quirks), and is **not authoritative** — if our
stored host string ever drifts from GitHub's real URL, every link breaks silently.

**Rejected — hybrid (backend `htmlUrl` for the button, frontend builder
elsewhere).** Two URL-source mechanisms to keep consistent; worst for
maintainability.

### D2 — One component, method-presence-gated desktop intercept

A new `OpenInGitHubButton` takes `href` (the `htmlUrl`) and renders an
`<a href={href} target="_blank" rel="noreferrer">` using the global
`btn btn-secondary` class (matching `AskAiButton`), with a GitHub icon **and** the
text label "Open in GitHub". **Link semantics are intentionally preserved** — no
`role="button"` override, so screen readers announce a link and right-click → *Copy
link* works; `Space` does not activate it, which is correct and expected for an
anchor. The exact visual treatment is the B1 gate; this decision fixes only the
element semantics and base class so two implementers don't diverge.

- **Placement:** **far-right of `.prActions`, after `AskAiButton`** — grouped with
  the auxiliary/escape controls and read last, after the review-workflow cluster
  (VerdictPicker / pending-pill / Submit). This is a stated position so the B1
  baseline is stable; the reviewer can still move it at the visual gate.
- **Desktop intercept (the correctness-critical guard):** open in the OS browser
  *only* when the bridge method actually exists —
  `if (typeof window.prism?.openExternal === 'function')` → `e.preventDefault()`
  then `window.prism.openExternal(href)`. **Gating on `openExternal` presence, not
  `window.prism?.isDesktop`,** is deliberate: a desktop shell built before this
  change exposes `isDesktop: true` with **no** `openExternal`; gating on `isDesktop`
  would `preventDefault()` and then call `undefined` → a TypeError and a dead
  control. Method-presence gating degrades correctly to the native anchor in that
  partial-build case.
- **Browser:** `window.prism` is undefined → the anchor's native `target="_blank"`
  opens a new tab; no JS path.
- **Post-click feedback:** **none in-app** — the OS taskbar/dock surfacing the
  launched browser is sufficient signal. `openExternal` returns `Promise<boolean>`;
  a `false` (validation reject or a `shell.openExternal` throw, see D3) is swallowed
  silently. That is acceptable because D1 guarantees the URL is a GitHub `https:`
  URL that always passes validation; the silent path is unreachable on the real
  data path, so a toast would be dead UX.
- **Graceful absence (all three link sites, one rule):** if `htmlUrl` is
  null/absent, **omit the link** — the button renders nothing, `DiffTruncationBanner`
  renders its text without the "Open on GitHub" link, and `SubmitDialog` drops the
  "View on GitHub" link. No site falls back to a reconstructed `github.com` URL (that
  would reintroduce rejected approach B) and none emits a broken relative link.
  Because a missing `htmlUrl` means the authoritative extraction silently failed and
  the whole escape-hatch disappears with no user-visible signal, `PrHeader` logs a
  **dev-side `console.warn`** when it renders a PR detail without `htmlUrl`, so a
  regression in `ParsePr` or the GraphQL shape is detectable rather than invisible.

### D3 — Desktop bridge: https-only validation + sender guard (the B2 surface)

`shell.openExternal` hands a string to the OS shell; unvalidated it is a known
footgun (`file://`, `javascript:`, `smb://`, …). Two guards:

- **`desktop/src/main.ts`**: `import { shell }`; add
  `ipcMain.handle('shell:open-external', …)`. The handler:
  1. **Sender guard first** — `if (!fromMainWindow(e)) return false;`, matching
     every existing `ipcMain` handler in `main.ts`. This restricts the channel to
     the main window's renderer; the https filter does not substitute for it (it
     does not constrain *which* renderer may call).
  2. **Protocol allowlist** — a pure exported predicate
     `isOpenableUrl(url: string): boolean` returning
     `new URL(url).protocol === 'https:'`, wrapped in `try/catch` so a malformed URL
     returns `false`. (Node's `URL` normalises the protocol to lowercase, so
     `HTTPS:` passes; userinfo/null-byte forms are handled by the OS shell, not the
     app.) Extracting the predicate keeps it unit-testable under `node --test`
     without launching Electron.
  3. **Open** via `shell.openExternal(url)` inside a `try/catch`, returning `true`
     on success and `false` on a validation miss or a thrown open. Never throws to
     the renderer.
- **`desktop/src/preload.ts`**: add `openExternal(url): Promise<boolean>` to the
  `contextBridge`, invoking `ipcRenderer.invoke('shell:open-external', url)`.
- **`frontend/src/types/shell.d.ts`**: add
  `openExternal(url: string): Promise<boolean>` to `PrismApi`.

**Rejected — protocol + host allowlist (require URL host == configured GitHub
host).** Tightest, but `main.ts` does not know the configured host (it lives in
backend/sidecar config, not the Electron main process), so this would drag host
config across the sidecar seam. Host-pinning *would* add defense-in-depth against a
**compromised transport** (a MITM or rogue GHES serving a crafted `url`), but that
threat is out of scope for this feature and requires defeating TLS — a far stronger
precondition than anything introduced here. Protocol-only validation plus the sender
guard is the correct risk tradeoff for this scope.

## Acceptance criteria

- [ ] An "Open in GitHub" control (GitHub icon + label) appears in the PR-detail
  header `.prActions` and opens that PR's correct GitHub web page.
- [ ] Works for **GHES / enterprise hosts** — every link path uses the authoritative
  `htmlUrl`; **no hardcoded `github.com` host string remains** in `FilesTab`,
  `DiffPane`, `DiffTruncationBanner`, or `SubmitDialog`.
- [ ] `DiffTruncationBanner`'s visible link label reads **"Open on GitHub"** (not
  "Open on github.com"), correct for any host.
- [ ] **Desktop**: the link opens in the **OS browser**, not inside the Electron
  window. **Browser build**: opens in a **new tab**.
- [ ] **Partial/older desktop build** (`isDesktop:true`, no `openExternal`): the
  click falls through to native anchor navigation — no TypeError, no dead control.
- [ ] The desktop handler **refuses** non-`https:` URLs (`http:`, `file:`,
  `javascript:`, malformed) and **rejects calls from any non-main-window sender** —
  neither reaches `shell.openExternal`.
- [ ] When `htmlUrl` is absent, the button, the `DiffTruncationBanner` link, and the
  `SubmitDialog` "View on GitHub" link are all **omitted** (no dead/broken link), and
  a dev-side `console.warn` fires.

## Test plan

Non-bug enhancement → tests authored test-first (red → green within the PR); no
red-on-main requirement.

- **Backend (xUnit)**: extend `ParsePr` mapping coverage — `url` → `HtmlUrl`,
  **and the empty/absent case maps to `null`** (not `""`).
- **Frontend (vitest)**:
  - `OpenInGitHubButton`: renders an anchor with correct `href` / `target="_blank"`
    / `rel="noreferrer"` in the **browser** case; in the **desktop** case (mock
    `window.prism.openExternal`) the click calls `openExternal(href)` and suppresses
    navigation; in the **partial-build** case (`isDesktop:true`, `openExternal`
    undefined) navigation is **not** suppressed and nothing throws.
  - `PrHeader`: renders the control when `htmlUrl` present; renders nothing + warns
    when absent.
  - `DiffTruncationBanner` / `SubmitDialog`: link uses the passed `htmlUrl` (assert
    against a **non-`github.com` GHES base** so host-correctness is actually
    exercised), label reads "Open on GitHub", and the link is omitted when `htmlUrl`
    is absent.
- **Desktop (`node --test`)**: `isOpenableUrl` accepts `https:` (incl. `HTTPS:`),
  rejects `http:`, `file:`, `javascript:`, and malformed input — the exact case list
  is the predicate's contract.
- **Playwright e2e**: on PR detail, the "Open in GitHub" control is present with the
  expected `href`. Required by the standing wire-shape rule (a new DTO field with
  frontend consumers must be exercised end-to-end, not just unit-mocked).

## Risk classification

**Gated — B1 + B2.**

- **B1 (UI-visual)**: a new visible control in `.prActions` (now a **4th persistent
  control** in the header action cluster); placement, icon, and crowding need a
  human eyeball. The B1 gate must sanity-check **header `.prActions` density
  specifically** — see Scope note; this is *not* covered by #185. `area:pr-detail`.
- **B2 (desktop sidecar / security surface)**: introduces a new IPC channel and a
  `contextBridge` method, and calls `shell.openExternal` — an Electron
  security-sensitive API. `area:desktop`. Mitigated by the sender guard + https-only
  predicate (D3); still gated because the *approach* on this surface warrants human
  review.

Because B2 fires the gate **early** (on the approach), the human reviews this spec
before any plan or code. The B1 eyeball-assert happens later, at green-and-ready.

## Scope

- **In:** `HtmlUrl` on `Pr` + `ParsePr` extraction (empty→null); `htmlUrl` on the
  frontend `PrDetailPr` type and its plumbing — `PrDetailView → PrHeader` (button)
  and the `FilesTab → DiffPane → DiffTruncationBanner` `prUrl` chain and a new
  `SubmitDialog` `htmlUrl?` prop; the `DiffTruncationBanner` label change ("Open on
  GitHub"); the `OpenInGitHubButton` component; the desktop `shell:open-external`
  IPC (sender guard + `isOpenableUrl` predicate) + preload bridge + `shell.d.ts`
  type; the tests above.
- **Out (YAGNI for #131):** a copy-link affordance; a dropdown of multiple GitHub
  actions (but see the trajectory note in D-notes); opening non-PR GitHub pages;
  threading the configured host into the Electron main process (rejected in D3);
  reworking the **Files-tab diff toolbar** density — *that* is
  [#185](https://github.com/prpande/PRism/issues/185), a different surface
  (`FilesTab.tsx:427-473`), **not** the header `.prActions` this button lands in.
  The header-cluster crowding this button adds is untracked and handled at the B1
  gate, not by #185.

**Trajectory note.** A single flat button is deliberately the v1, not a dead-end:
if a second GitHub destination is ever needed, this control is the anchor that would
become a split/overflow control. No code implication now.

## Plan-time verifications (carried into writing-plans)

- **`Pr` record shape (confirmed positional):** `Pr` is a positional `sealed record`
  with a trailing optional `AvatarUrl = null` precedent — add `string? HtmlUrl = null`
  as the trailing positional param (source-compatible with existing constructors).
- **Consumer reach (confirmed):** `PrDetailView` has `prDetail.pr`; `PrHeader`,
  `FilesTab`/`DiffPane`/`DiffTruncationBanner`, and `SubmitDialog` are flattened-prop
  components needing `htmlUrl` threaded as described in D1 (not a leaf "consume").
- **GraphQL `url` presence (hard pre-merge check, not optional):** confirm `url` is
  populated for the PR-detail query path in **both open and merged/closed** states.
  This is the trigger for the D2 silent-failure path — if it can ever be empty, the
  `console.warn` + omit-link behavior is the safety net, but the assumption must be
  verified, not assumed.
