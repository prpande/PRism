# Help & Feedback surface — design

- **Issues:** [#210](https://github.com/prpande/PRism/issues/210) (Help / Guide page + nav entry), [#211](https://github.com/prpande/PRism/issues/211) (in-app bug report / feedback)
- **Tier:** T3 (slice-sized, net-new behavior, cross-tier: frontend route + dialog + new backend endpoint + GitHub write call)
- **Risk:** **Gated.** B1 (both issues carry `design`/`needs-design`) **and** B2 (a new GitHub *write* call using the user's PAT; auto-attached context handling). Human gates on spec and plan are retained; the machine `ce-doc-review` pass is a quality pre-pass, not a gate substitute.
- **Worktree / branch:** `D:/src/PRism-wt/210-211-help-feedback` on `feature/210-211-help-feedback`

## 1. Problem

PRism ships no in-app help and no way to send feedback.

- **#210:** A new user has nowhere to learn what PRism is or how to use it. The authed chrome is `Inbox` tab + a `⚙` gear (Settings is now a modal, not a tab); there is no Help route, glossary, or guided orientation. The only discoverability affordance is the `⌘K` cheatsheet, which lists shortcuts but explains nothing.
- **#211:** There is no affordance anywhere to report a bug or send feedback. User-encountered friction never reaches the developer unless the user *is* the developer.

The two are coupled by #211's own acceptance criterion: the feedback entry point must be **coordinated with #210 into a single coherent "get help / give feedback" area, not two scattered links.** They are therefore designed and specced together (they may still ship as separate PRs — see §10).

## 2. Goals / non-goals

**Goals**

1. A **static, scannable `/help` guide** reachable in *every* auth state (including first-run, when the nav is hidden).
2. A **discoverable Help entry point**: a `?` icon in the header (authed) and the existing `Help` footer stub on `/welcome` (first-run).
3. An **in-app feedback form** that files a GitHub issue in a dedicated public feedback repo, with a graceful prefilled-link fallback when the user's token can't create the issue directly.
4. **One coherent Help+Feedback area**: feedback is launched from the Help page (its primary home), plus the `/welcome` footer stub.

**Non-goals (this slice)**

- Interactive product tour / walkthrough (issue says start static; defer).
- Auto-attaching "last error" context (no error store exists; deferred — §8, §11).
- A server-side feedback proxy / PRism-owned service identity (evaluated and rejected for the PoC — §4.3).
- Replacing or expanding the `⌘K` cheatsheet (Help *links* to it).
- Owning PAT-type (fine-grained vs classic) guidance — that is **#213's** territory; Help links to it.

## 3. Architecture overview

```
Header (authed)            WelcomePage (first-run)
   │ ? icon                   │ "Help"  "Send feedback" footer links
   ▼                          ▼              │
 /help route  ◄───────────────┘              │
   │ HelpPage (static guide; auth-agnostic)  │
   │   └─ "Send feedback" button ────────────┤
   ▼                                         ▼
        FeedbackDialog (modal, auth-adaptive)
                 │ submit
        ┌────────┴─────────────────────────────┐
   authed (has PAT)                     first-run (no PAT)
        │ POST /api/feedback                    │ (skip API)
        ▼                                       │
  FeedbackEndpoint → IFeedbackSubmitter         │
        │ POST /repos/prpande/PRism-feedback/issues (user PAT)
        ├─ 201 → { issueNumber, htmlUrl }        │
        └─ 403/404 → CannotCreate ──────────────┤
                                                 ▼
                          prefilled issues/new link → openExternal
                          (browser github.com session files it)
```

Key property: **the prefilled-link path is both the universal fallback (authed create failed) and the first-run primary (no token to create with).** One form, one fallback mechanism, two triggers.

## 4. Feedback transport

### 4.1 Why through the backend

The frontend never holds the PAT — it lives in the sidecar behind `SessionTokenMiddleware`. So an API-create must be a backend call. A new `POST /api/feedback` endpoint delegates to a new `IFeedbackSubmitter` implemented in `PRism.GitHub`, which calls `POST /repos/{owner}/{repo}/issues` reusing the existing authenticated `SendGitHubAsync` pattern (the same helper the submit pipeline uses for authenticated POSTs).

### 4.2 Issue construction

| Field | Source | Maps to |
|-------|--------|---------|
| Category — `Bug` \| `Idea` \| `Other` | form (required, default `Bug`) | issue **label** (`bug` / `enhancement` / `feedback`) + title prefix |
| Summary | form (required, short) | issue **title**: `[Bug] <summary>` |
| Details | form (required, multiline; bug placeholder prompts repro steps) | issue **body** (top section) |
| Route pattern | frontend `useLocation` → matched route *pattern* (`/pr/:owner/:repo/:number`, **not** the concrete path) | body "Context" section |
| Platform | `window.prism?.isDesktop` → `desktop`/`browser` (+ `platform`) | body "Context" section |
| App / build version | **backend-stamped** from assembly version (authoritative; FE `package.json` is a placeholder) | body "Context" section |
| Submitted-at | backend timestamp | body "Context" section |

The body is assembled as: user details, then a fenced `Context` block of the allowlisted fields above.

### 4.3 Why user-PAT + link fallback, not an embedded token or a proxy

- **Embedded fine-grained token (rejected):** a token shipped in the binary/code is a published secret — extractable via `strings`/DevTools, **auto-revoked by GitHub secret scanning** if the code or repo is ever public, un-rotatable without re-shipping, and fine-grained PATs expire (≤1 yr). Violates the repo's secrets policy. Not viable.
- **Serverless proxy holding the token (rejected for the PoC):** the correct way to get a PRism-owned identity, but it adds infra to maintain and a network dependency outside the local-first model. Documented as the upgrade path when an external tester base justifies it.
- **User-PAT create + link fallback (chosen):** zero infra, no shipped secret. The issue is authored by the filer's GitHub account. A classic PAT (PRism's recommended path, full `repo` scope) creates the issue directly. A fine-grained PAT (per-repo scoped, won't include the feedback repo) gets 403/404 → the prefilled-link fallback.

### 4.4 Prefilled-link fallback

On a `CannotCreate` result (403/404) — or unconditionally in the first-run no-token case — the frontend builds:

```
https://github.com/prpande/PRism-feedback/issues/new?title=<enc>&body=<enc>&labels=<enc>
```

and opens it via the existing `window.prism.openExternal(url)` bridge (the `OpenInGitHubButton` pattern), with a `target="_blank"` browser fallback. The user lands on GitHub's New Issue page **prefilled**, and clicks Submit there (filing via their browser's github.com session).

- **Offered, not automatic.** On API failure the dialog shows an inline line — *"Couldn't file it directly. Open a prefilled issue on GitHub instead?"* — plus a button. No unannounced tab-switch on what might be a transient error.
- **URL-length asymmetry.** The query string is bounded (~8 KB practical). The link path therefore carries a trimmed body (details + minimal context); the API path can carry the full context block. If the assembled URL would exceed a safe cap (e.g. 6 KB), the link path truncates the body with a "(truncated — see app)" marker.
- **Public-repo dependency.** The browser-session route needs github.com access to the repo. `prpande/PRism-feedback` is **public**, so any logged-in GitHub user can file. (A private repo would break the fallback for non-collaborators — hence public is a hard requirement, not a preference.)

### 4.5 Configuration

The feedback repo is a configurable `owner/name` with default `prpande/PRism-feedback`. Surfaced as a single backend config value (consumed by `IFeedbackSubmitter` for the API path and echoed to the frontend — via the existing capabilities/config channel — for the link path), so both paths target the same repo from one source of truth. No new persisted-schema migration is required (read-only config constant with a default; not written to `state.json`).

## 5. Frontend components

- **`/help` route** — added to `App.tsx` Routes, rendered **outside** the `isAuthed` gates (like `/welcome`) so it resolves in first-run, rejected-token, and authed states.
- **`HelpPage`** (`pages/HelpPage.tsx`) — static, scannable guide. Sections: what PRism is → core loop (Inbox → PR detail → submit) → what each surface does (Inbox, PR-detail tabs, Settings) → connect/replace your **GitHub PAT** (links to Settings → GitHub Connection; links to **#213** for PAT-type guidance) → keyboard shortcuts (links to `⌘K`). Concise structural copy, no screenshots (cheap to keep in sync). Hosts the primary **"Send feedback"** trigger.
  - **Content fix:** the guide says **GitHub PAT**, never "Azure DevOps token" (#210's body is stale; the app is GitHub-only — `GitHubConnectionPane`, `PRism.GitHub`).
- **Header `?` icon** — a Link/button beside the `⚙` gear, rendered when `isAuthed` (mirrors the gear's icon-opens-surface pattern). Navigates to `/help`. Respects the existing a11y landmark structure (no empty `<nav>`).
- **`/welcome` footer wiring** — the two existing inert `<span>` stubs become: `Help` → navigates to `/help`; `Send feedback` → opens `FeedbackDialog`. Stubs must become real links/buttons (announced as such).
- **`FeedbackDialog`** (`components/Feedback/FeedbackDialog.tsx`) — modal (Settings/Cheatsheet conventions: focus trap, Esc, restore-focus, `aria-modal`). Fixed-format form (category, summary, details). Auth-adaptive:
  - authed → POST `/api/feedback`; on success "Filed as #N" with an Open-in-GitHub link; on `CannotCreate` → offered link fallback; on network/5xx → error with retry + offered link.
  - first-run (no token) → submit goes straight to the prefilled link.
  - A "don't paste tokens/secrets" hint sits by the details field (free text is not scrubbed).

## 6. Backend components

- **`POST /api/feedback`** (`PRism.Web/Endpoints/FeedbackEndpoints.cs`) — request DTO `{ category, summary, details, routePattern, platform }`; validates required fields; stamps version + timestamp; calls `IFeedbackSubmitter`. Returns `201 { issueNumber, htmlUrl }`, or a typed `409/422`-style `CannotCreate` body the frontend maps to the fallback (distinct from a `500`/network error).
- **`IFeedbackSubmitter`** (`PRism.Core`) + **`GitHubFeedbackSubmitter`** (`PRism.GitHub`) — builds title/body/labels, POSTs `repos/{owner}/{repo}/issues` via `SendGitHubAsync`. Maps `201`→`Created(number, htmlUrl)`, `403`/`404`→`CannotCreate`, other non-2xx→throw (→ endpoint 5xx). Honors the Octokit/source-hygiene invariant (no PR/issue *content* logged; only structured status).
- **Allowlist guarantee:** the issue body is assembled from the named fields only; there is no pass-through of arbitrary client objects, so a secret cannot ride along by construction.

## 7. Data flow

1. **Authed happy path:** form → `POST /api/feedback` → `201` → "Filed as #N" + link. No app exit.
2. **Authed, token can't create:** `403/404` → `CannotCreate` → offered prefilled-link → `openExternal` → user submits on github.com.
3. **First-run (no token):** form → prefilled-link directly → `openExternal`.
4. **Network/5xx:** error state + retry; offered link as escape hatch.

## 8. Error handling & edge cases

- **403/404 vs 5xx/network** are distinguished so only the former auto-offers the link (the latter offers retry first).
- **URL too long** → truncate link body with a marker (§4.4).
- **`openExternal` absent** (browser build) → native `target="_blank"`.
- **Empty/whitespace summary or details** → client-side validation blocks submit.
- **Route pattern** is the matched pattern, never the concrete path → no repo/PR id leak.
- **Deferred:** last-error auto-attach (no store exists); a `last error` field would need new plumbing — out of scope, filed as follow-up.

## 9. Testing strategy

- **Backend (xUnit):** `GitHubFeedbackSubmitter` maps `201`/`403`/`404`/`5xx` correctly (fake HTTP handler); body/labels assembled from allowlisted fields; version stamped; endpoint validation (missing fields → 4xx); `CannotCreate` distinct from `500`. Test-first (red→green within PR history; non-bug work).
- **Frontend (vitest/RTL):** `FeedbackDialog` validation; authed success renders "Filed as #N"; `CannotCreate` renders the offered link and the link encodes title/body/labels; first-run path skips the API and goes straight to link; `HelpPage` renders sections and the feedback trigger; `/help` resolves in unauthed + authed; Header `?` navigates; welcome stubs are now interactive.
- **e2e (Playwright):** `/help` reachable from `?` (authed) and welcome footer (first-run); feedback dialog opens, validates, and (mock) success path. B1 visual assert on the `/help` page + dialog via screenshots on the PR (per the B1 gate).

## 10. Suggested PR phasing (for writing-plans)

- **PR1 — Help surface (#210):** `/help` route + `HelpPage` + Header `?` + welcome `Help` link + content. Frontend-only, no risk surface beyond B1; smaller, independently shippable.
- **PR2 — Feedback pipeline (#211):** `FeedbackDialog` + welcome `Send feedback` wiring + `POST /api/feedback` + `IFeedbackSubmitter` + fallback + config. Carries the B2 risk surface.

Phasing is a planning recommendation; writing-plans owns the final breakdown.

## 11. Open questions / deferrals

- **D1 — last-error context:** deferred (no store). Follow-up issue to add an error store feeding the feedback context.
- **D2 — serverless proxy upgrade:** documented as the path to PRism-owned attribution + private repo + no browser hop, when an external tester base justifies the infra.
- **D3 — labels exist in the feedback repo:** the API path applies labels (`bug`/`enhancement`/`feedback`); these must exist in `prpande/PRism-feedback` or the create may 422. Owner to create the labels, or the submitter omits labels on the first cut (decide in planning).
- **D4 — capabilities/config channel for the repo slug:** confirm the existing config channel the frontend reads is the right carrier for the link-path repo slug (vs a build-time constant). Resolve in planning.

## 12. Acceptance criteria (restated, checkable)

- [ ] A `/help` page exists, reachable from a `?` header affordance (authed) and the `/welcome` footer (first-run); explains the core workflow and each primary surface in scannable form; respects nav a11y landmarks; first-run reachability implemented (route is auth-agnostic).
- [ ] The guide references GitHub PAT (not Azure DevOps) and links to #213 for PAT-type detail.
- [ ] A user can initiate feedback from a discoverable in-app entry point coordinated with Help (single coherent area).
- [ ] Feedback files a GitHub issue end-to-end in `prpande/PRism-feedback` (API create when the PAT allows; offered prefilled-link fallback otherwise and for first-run).
- [ ] Auto-attached context is allowlisted (category, summary, details, route *pattern*, platform, version) — no token/PR-id leak by construction.
- [ ] Entry points are coordinated (Help hub + welcome footer), not scattered.
