# Help & Feedback surface — design

- **Issues:** [#210](https://github.com/prpande/PRism/issues/210) (Help / Guide page + nav entry), [#211](https://github.com/prpande/PRism/issues/211) (in-app bug report / feedback)
- **Tier:** T3 (slice-sized, net-new behavior, cross-tier: frontend route + dialog + new backend endpoint + GitHub write call)
- **Risk:** **Gated.** B1 (both issues carry `design`/`needs-design`) **and** B2 (a new GitHub *write* call using the user's PAT; auto-attached context handling). Human gates on spec and plan are retained; the machine `ce-doc-review` pass is a quality pre-pass, not a gate substitute.
- **Worktree / branch:** `D:/src/PRism-wt/210-211-help-feedback` on `feature/210-211-help-feedback`
- **Prerequisite (satisfied):** `prpande/PRism-feedback` exists, is **public**, and has issues enabled (verified). Public is a hard invariant — see §4.4.

## 1. Problem

PRism ships no in-app help and no way to send feedback.

- **#210:** A new user has nowhere to learn what PRism is or how to use it. The authed chrome is `Inbox` tab + a `⚙` gear (Settings is now a modal, not a tab); there is no Help route, glossary, or guided orientation. The only discoverability affordance is the `⌘K` cheatsheet, which lists shortcuts but explains nothing.
- **#211:** There is no affordance anywhere to report a bug or send feedback. User-encountered friction never reaches the developer unless the user *is* the developer.

The two are coupled by #211's own acceptance criterion: the feedback entry point must be **coordinated with #210 into a single coherent "get help / give feedback" area, not two scattered links.** The only *hard* coupling is **entry-point coordination** — #210 (a frontend-only B1 page) can ship and deliver value independently even if #211 (the gated B2 write path) slips in review. They are therefore designed together but phased apart (§10).

## 2. Goals / non-goals

**Goals**

1. A **static, scannable `/help` guide** reachable in *every* auth state (including first-run, when the nav is hidden).
2. A **discoverable Help entry point**: a `?` icon in the header (authed) and the existing `Help` footer stub on `/welcome` (first-run).
3. An **in-app feedback form** that files a GitHub issue in a dedicated public feedback repo, with a graceful prefilled-link fallback when the user's token can't create the issue directly.
4. **One coherent Help+Feedback area**: feedback is launched from the Help page (its primary home), plus the `/welcome` footer stub.

**Non-goals (this slice)**

- Interactive product tour / walkthrough (issue says start static; defer).
- Auto-attaching "last error" context (no error store exists; deferred — §8, §11).
- Category **labels** on the created issue (deferred — §4.2, §11 D3; avoids a label-must-exist dependency on the first cut).
- A server-side feedback proxy / PRism-owned service identity (evaluated and rejected for the PoC — §4.3).
- Replacing or expanding the `⌘K` cheatsheet (Help *links* to it).
- Owning PAT-type (fine-grained vs classic) guidance — that is **#213's** territory; Help links to it.

**Local-first boundary (clarification).** PRism's "local-first" promise (`WelcomePage`: *"your PAT never leaves this device"*) is a **credential/data-storage** promise: the PAT and PR data stay on-device. Feedback is an explicit, **user-initiated** action that deliberately produces public off-device state (a GitHub issue). The PAT is still used only locally by the sidecar — it is not exfiltrated — so the literal promise holds, but the boundary is stated here so the feature doesn't read as contradicting the welcome screen.

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
   authed + host is github.com            first-run (no PAT)
        │ POST /api/feedback              OR GHES host (§4.1)
        ▼                                       │
  FeedbackEndpoint → GitHubFeedbackSubmitter    │
        │ POST api.github.com/repos/prpande/PRism-feedback/issues (user PAT)
        ├─ 201 → { issueNumber, htmlUrl }        │
        ├─ scope-denied 403 / 404 → CannotCreate ┤
        ├─ rate-limit 403 → RateLimited (retry)  │
        └─ 422 (e.g. label) → CannotCreate ──────┤
                                                 ▼
                          prefilled issues/new link → openExternal
                          (browser github.com session files it)
```

Key property: **the prefilled-link path is both the universal fallback (authed create failed) and the primary path for the first-run and GHES-host cases.** One form, one fallback mechanism, several triggers.

## 4. Feedback transport

### 4.1 Why through the backend, and the github.com host requirement

The frontend never holds the PAT — it lives in the sidecar behind `SessionTokenMiddleware`. So an API-create must be a backend call: a new `POST /api/feedback` endpoint delegates to a new `GitHubFeedbackSubmitter` in `PRism.GitHub` that calls `POST /repos/{owner}/{repo}/issues`.

**Host resolution (corrected).** The existing `SendGitHubAsync` is a *private* member of `GitHubReviewService` bound to the **host-scoped** `"github"` HttpClient (`BaseAddress` = `HostUrlResolver.ApiBase(config.Github.Host)` — `https://api.github.com/` for github.com, `<host>/api/v3/` for GHES). The feedback submitter therefore **cannot** call `SendGitHubAsync` directly, and **must not** inherit the host-scoped client: the feedback repo lives on **github.com unconditionally**, so a POST resolved against a GHES base would 404 against the wrong host.

Resolution:
- The shared per-request header block (Bearer, UserAgent, Accept, `X-GitHub-Api-Version`) is extracted into an `internal` helper in `PRism.GitHub` and called by both `GitHubReviewService` and the new submitter (or inlined in the submitter — planning decides; the spec no longer claims direct reuse of the private method).
- The submitter targets **`api.github.com` explicitly** (absolute URL), not the host-scoped client.
- **When the user's configured host is not github.com (GHES), skip the API path entirely and go straight to the prefilled-link fallback.** A GHES PAT won't authenticate against api.github.com, and the github.com browser session reached by the fallback may be a *different identity* than the user's enterprise account — this is acceptable for a PoC (the user files under whatever github.com identity they have, or none) but is called out so it's a deliberate choice, not a silent 404.

### 4.2 Issue construction

| Field | Source | Maps to |
|-------|--------|---------|
| Category — `Bug` \| `Idea` \| `Other` | form (required, default `Bug`) | issue **title prefix** (`[Bug]`/`[Idea]`/`[Other]`). *Labels deferred — §11 D3.* |
| Summary | form (required, ≤120 chars) | issue **title**: `[Bug] <summary>` |
| Details | form (required, multiline, ≤4000 chars; bug placeholder prompts repro steps) | issue **body** (top section) |
| Route pattern | frontend `useLocation` → matched route *pattern* (`/pr/:owner/:repo/:number`, **not** the concrete path) | body "Context" section |
| Platform | `typeof window.prism?.openExternal === 'function'` → `desktop`, else `browser`; plus `window.prism?.platform` when present | body "Context" section |
| App / build version | **backend-stamped** from assembly version (authoritative; FE `package.json` is a placeholder) | body "Context" section |
| Submitted-at | backend timestamp | body "Context" section |

The body is assembled as: user details, then a fenced `Context` block of the allowlisted fields above.

> **`isDesktop` is not the discriminator.** Per `OpenInGitHubButton.tsx`, `window.prism.isDesktop` can be `true` on a partial desktop build with no `openExternal`. The platform field gates on the *method's* presence, consistent with that precedent.

> **Field-length caps are validated server-side too** (summary ≤120, details ≤4000), not only in the form — the endpoint must not trust the client. Caps also bound the link-path URL budget (§4.4).

### 4.3 Why user-PAT + link fallback, not an embedded token or a proxy

- **Embedded fine-grained token (rejected):** a token shipped in the binary/code is a published secret — extractable via `strings`/DevTools, **auto-revoked by GitHub secret scanning** if the code or repo is ever public, un-rotatable without re-shipping, and fine-grained PATs expire (≤1 yr). Violates the repo's secrets policy. Not viable.
- **Serverless proxy holding the token (rejected for the PoC):** the correct way to get a PRism-owned identity, but it adds infra to maintain and a network dependency outside the local-first model. Documented as the upgrade path (D2) when an external tester base — or feedback volume/abuse — justifies it.
- **User-PAT create + link fallback (chosen):** zero infra, no shipped secret. The issue is authored by the filer's GitHub account. A classic PAT (PRism's recommended path, full `repo` scope) creates the issue directly. A fine-grained PAT (per-repo scoped, won't include the feedback repo) gets 404 → the prefilled-link fallback.

**Acknowledged population split.** PAT-type guidance is unsettled (#213), and GitHub nudges new users toward fine-grained PATs. So the prefilled-link path may be the *common* path in practice, not a rare fallback. The design accepts this: classic users (PRism's documented recommendation) get the in-app create; everyone else gets a prefilled browser hop. Both file successfully. Because the link path may be the de-facto primary, its UX (truncation, the "open on GitHub" confirmation state) gets first-class treatment in §5, not edge-case treatment. **Open decision DEC-A (§13): whether the B2 API path earns its risk surface on the first cut, or PR2 ships link-only first.**

### 4.4 Prefilled-link fallback

On a `CannotCreate` result (scope-denied 403 / 404 / 422) — or unconditionally in the first-run no-token and GHES-host cases — the frontend builds:

```
https://github.com/prpande/PRism-feedback/issues/new?title=<enc>&body=<enc>
```

and opens it via `window.prism.openExternal(url)` (the `OpenInGitHubButton` pattern), with a `target="_blank"` browser fallback when the bridge is absent, and an explicit error toast if `openExternal` is present but throws. The user lands on GitHub's New Issue page **prefilled**, and clicks Submit there (filing via their browser's github.com session).

- **Offered, not automatic.** On API failure the dialog transitions to a confirmation state (§5) with the offered link — no unannounced tab-switch on what might be a transient error.
- **URL-length asymmetry.** The query string is bounded (~6 KB safe cap; GitHub's tolerance is undocumented, so the cap is conservative). The link path carries a trimmed body; the API path carries the full context block. Multibyte/emoji content expands under percent-encoding, so truncation is measured on the *encoded* length. When truncated, the body ends with a **context-aware marker**: `(truncated)` plus, only when an API record also exists, "see the app"; in the first-run / GHES / fine-grained cases (no API record) the marker instead invites the user to add detail directly in the issue.
- **Public-repo dependency and its tradeoff.** The browser-session route needs github.com access to the repo. `prpande/PRism-feedback` is **public**, so any logged-in GitHub user can file. The cost: feedback issues are **public and attributed** to the filer, and the repo is an **open write surface** (spam/abuse possible). A private repo would make the fallback collect nothing for non-collaborators and is therefore incompatible with the "collect from everyone" goal. Public is kept; the chilling/abuse tradeoff is surfaced as **open decision DEC-B (§13)** with an informed-consent mitigation in §5.

### 4.5 Configuration

The feedback repo slug defaults to `prpande/PRism-feedback`. It is needed in two places: the backend (API-create path) and the frontend (link-path URL). Since `/api/capabilities` currently carries only `{ ai }` and **no config-push channel exists**, this slice uses a **shared build-time constant** (a single source consumed by both tiers — e.g. a generated/duplicated constant kept in sync, decided in planning) rather than introducing a new config endpoint. Runtime configurability is out of scope; the slug is **not** a user-writable preference (so a user cannot redirect submissions to an arbitrary repo), and **not** written to `state.json` (no persisted-schema migration).

## 5. Frontend components

- **`/help` route** — added to `App.tsx` Routes, rendered **outside** the `isAuthed` gates (like `/welcome`) so it resolves in first-run, rejected-token, and authed states.
- **`HelpPage`** (`pages/HelpPage.tsx`) — static, scannable guide.
  - **Content hierarchy:** `<h1>Help`, then one `<h2>` per section, each with a stable `id` (for future deep-linking). Sections, in order: what PRism is → core loop (Inbox → PR detail → submit) → what each surface does → connect/replace your **GitHub PAT** (links to Settings → GitHub Connection; links to **#213** for PAT-type guidance) → keyboard shortcuts (links to `⌘K`). A **"Send feedback"** button sits after the last section (its primary, discoverable home).
  - **Copy constraints (anti-AI-slop):** each section opens with a *user task* ("To review a PR…", "When you need to replace your token…"), not a feature description; surfaces are named with their **exact in-app labels** (Inbox, the PR-detail tab names, the Submit dialog), not paraphrased; **no emoji/icons in headings**; concise structural copy, no screenshots (cheap to keep in sync).
  - **Content fix:** the guide says **GitHub PAT**, never "Azure DevOps token" (#210's body is stale; the app is GitHub-only — `GitHubConnectionPane`, `PRism.GitHub`).
- **Header `?` icon** — a Link beside the `⚙` gear, rendered when `isAuthed`. Navigates to `/help`. Gains an **active style + `aria-current="page"` when `pathname === '/help'`** (mirrors the gear's `gearOn`/`settingsActive` pattern). Respects the existing a11y landmark structure.
- **Entry points by auth state:** authed → header `?` + welcome-footer (if they return there); first-run → welcome footer; **rejected-token** (on `/setup`, `isAuthed` false) → no `?` icon (matches the gear's gating) — reachable via direct URL only, which is acceptable since that state is a focused re-auth. No always-visible `?` is added (that would be a scope expansion).
- **`/welcome` footer wiring** — the two existing inert `<span>` stubs become: `Help` → navigates to `/help`; `Send feedback` → opens `FeedbackDialog`. Stubs become real links/buttons (announced as such).
- **`FeedbackDialog`** (`components/Feedback/FeedbackDialog.tsx`) — modal over the shared `Modal` (focus trap, restore-focus, `aria-modal`). The form renders **identically** in authed and first-run states (no "you're not signed in" banner); only the submit action differs.
  - **Form:** Category as a **radiogroup / segmented tabs** (the #213 pattern), default `Bug`, `aria-label="Feedback category"`; Summary (text, maxlength 120); Details (textarea, maxlength 4000, bug placeholder prompts repro steps). A persistent **"This is posted as a public GitHub issue under your account — don't include tokens or secrets"** notice sits above the submit row (informed consent + the security hint, per DEC-B and the free-text leak risk).
  - **Initial focus:** the Category group's first option (form-dialog APG convention — not the submit button).
  - **Validation:** submit disabled until Category, Summary, and Details are all non-empty/non-whitespace (SetupForm's disabled-button pattern; no per-field error labels).
  - **Interaction states (all enumerated so the `Modal` props are deterministic):**
    - *Idle:* submit label `Send feedback` (authed/github.com) or `Open on GitHub` (first-run/GHES — the action is a browser hop, set expectation).
    - *In-flight* (API path only): submit disabled, label `Sending…`, fields read-only, Esc suppressed.
    - *Success* (API 201): title → "Feedback sent"; body "Filed as #N" + an Open-in-GitHub link (via `openExternal`); single `Close` button; Esc re-enabled; fields not re-editable.
    - *CannotCreate / first-run / GHES* (offered link): title → "Open on GitHub"; body explains the prefilled issue page will open; `Open on GitHub` (primary) builds the URL and fires `openExternal`, then transitions to a "Opening GitHub…" confirmation state with a single `Close` (we do not assume the user completed the github.com submit).
    - *Network/5xx error:* inline `role="alert"` message below Details; fields remain editable; footer shows `Retry` (re-fires POST with current values) + `Open on GitHub instead` (the offered link).
    - *RateLimited (403 rate/secondary-limit):* a wait-and-retry message (the browser fallback would hit the same limit, so the link is **not** offered here) — distinct from CannotCreate.
    - *Esc:* if any field is dirty, Esc focuses `Cancel` (mirrors `SubmitDialog`, announced via aria-live); if the form is pristine, Esc dismisses.

## 6. Backend components

- **`POST /api/feedback`** (`PRism.Web/Endpoints/FeedbackEndpoints.cs`) — request DTO `{ category, summary, details, routePattern, platform }`; validates required fields **and length caps** (summary ≤120, details ≤4000 — reject oversize with 400); stamps version + timestamp; calls the submitter. Returns:
  - `201 { issueNumber, htmlUrl }` on success,
  - **`422 CannotCreate`** (single chosen status, not "409/422-style") when GitHub returns scope-denied 403 / 404 / 422 — the frontend maps this to the offered link,
  - **`429 RateLimited`** when GitHub returns a primary/secondary rate-limit 403 — the frontend maps this to wait-and-retry (no link),
  - `500` for genuine transport/5xx errors (frontend retry path).
- **`GitHubFeedbackSubmitter`** (`PRism.GitHub`) — a **package-internal class with a constructor seam** (`Func<Task<string?>> readToken`, `IHttpClientFactory`), **no `PRism.Core` interface** (single consumer, single method; the `IReviewSubmitter` interface earned its keep with a 7-method pipeline — this does not). Targets `api.github.com` explicitly (§4.1). Builds title/body (no labels — D3). Maps GitHub responses: `201`→`Created`; scope-denied `403`/`404`/`422`→`CannotCreate`; rate-limit `403` (detected via `X-RateLimit-Remaining: 0` or a "secondary rate limit" body)→`RateLimited`; other non-2xx→throw (→ endpoint 500). Honors the Octokit/source-hygiene invariant (no PR/issue *content* logged; only structured status).
- **Allowlist guarantee (scoped):** the **machine-collected** context (route pattern, platform, version, timestamp) is assembled from named fields only — a secret cannot ride along *in the context block* by construction. This guarantee does **not** extend to the user-authored summary/details, which are free text posted verbatim (mitigated by the in-dialog notice, not by scrubbing — §5, §11).

## 7. Data flow

1. **Authed, github.com, token can create:** form → `POST /api/feedback` → `201` → "Filed as #N" + link. No app exit.
2. **Authed, token can't create (scope/404/422):** `422 CannotCreate` → offered prefilled-link → `openExternal` → user submits on github.com.
3. **First-run (no token) or GHES host:** form renders identically; submit skips the API and builds the prefilled link directly → `openExternal`.
4. **Rate-limited:** `429 RateLimited` → wait-and-retry message (no link — same limit applies to the browser).
5. **Network/5xx:** error state + retry; offered link as escape hatch.

## 8. Error handling & edge cases

- **403 is sub-classified:** scope/permission → `CannotCreate` (offer link); rate/secondary-limit → `RateLimited` (wait-and-retry, no link). Mapping all 403s to the link would wrongly bounce a rate-limited classic user to a browser that hits the same limit.
- **404** (fine-grained PAT can't see the repo) → `CannotCreate`.
- **422** (e.g. a missing label, or other unprocessable) → `CannotCreate`, not a thrown 5xx — so a labels/validation issue degrades gracefully to the link instead of a retry-forever error. (Labels are omitted on the first cut anyway — D3 — but the mapping is defensive.)
- **GHES host** → API path skipped; link path only (§4.1).
- **URL too long** → truncate on encoded length, context-aware marker (§4.4).
- **`openExternal` absent** → native `target="_blank"`; **present but throws** → error toast.
- **Empty/whitespace or oversize fields** → client disables submit; server rejects oversize with 400.
- **Route pattern** is the matched pattern, never the concrete path → no repo/PR id leak.
- **Deferred:** last-error auto-attach (no store exists) — out of scope, filed as follow-up (D1).

## 9. Testing strategy

- **Backend (xUnit):** `GitHubFeedbackSubmitter` maps `201`/scope-`403`/rate-limit-`403`/`404`/`422`/`5xx` to the correct typed results (fake HTTP handler); targets `api.github.com` regardless of configured host; body assembled from allowlisted fields; version stamped; endpoint validation (missing/oversize fields → 4xx); `CannotCreate` vs `RateLimited` vs `500` are distinct. Test-first (red→green within PR history; non-bug work).
- **Frontend (vitest/RTL):** `FeedbackDialog` validation + every interaction state (idle/in-flight/success/CannotCreate-confirmation/RateLimited/error/Esc-dirty); authed success renders "Filed as #N"; `CannotCreate` and first-run both build a link encoding title+body; GHES/first-run skip the API; `HelpPage` renders sections with ids + the feedback trigger; `/help` resolves in unauthed + authed; Header `?` navigates and shows active state; welcome stubs are interactive.
- **e2e (Playwright):** `/help` reachable from `?` (authed) and welcome footer (first-run); feedback dialog opens, validates, and (mock) success + offered-link paths. B1 visual assert on `/help` + the dialog states via screenshots on the PR.

## 10. Suggested PR phasing (for writing-plans)

- **PR1 — Help surface (#210):** `/help` route + `HelpPage` + Header `?` (+ active state) + welcome `Help` link + content. Frontend-only, B1 only; smaller, **independently shippable** — its value does not depend on PR2.
- **PR2 — Feedback pipeline (#211):** `FeedbackDialog` + welcome `Send feedback` wiring + `POST /api/feedback` + `GitHubFeedbackSubmitter` + fallback + shared repo-slug constant. Carries the B2 risk surface.

Phasing is a planning recommendation; writing-plans owns the final breakdown.

## 11. Open questions / deferrals

- **D1 — last-error context:** deferred (no store). Follow-up issue to add an error store feeding the feedback context.
- **D2 — serverless proxy upgrade:** documented path to PRism-owned attribution + private repo + no browser hop. Trigger tied to **feedback volume / abuse / external-tester count**, not only "external tester base."
- **D3 — category labels:** **resolved — omit labels on the first cut.** Category maps to a title prefix only. Adding `bug`/`enhancement`/`feedback` labels (which must pre-exist in the repo or the create 422s) is a cosmetic follow-up; the 422 mapping (§8) is defensive in case they're added later.
- **D4 — repo-slug carrier:** **resolved — shared build-time constant** (no new config endpoint; not a user preference; not in `state.json`). Exact single-source mechanism decided in planning.

**Residual risks (acknowledged, not blocking):**
- **Free-text PII/secret exposure:** summary/details post verbatim to a *public* issue under the user's real identity. Mitigation is the in-dialog notice (§5) + GitHub secret-scanning's reactive revocation; not eliminated. No client-side secret-pattern detection in this slice (could be a follow-up).
- **Prefilled URL in browser history:** the link path puts summary/details in a URL (history, address bar, possibly proxy/DLP logs) before the user submits.
- **Public-repo moderation surface:** any logged-in GitHub user can file via the fallback; triage/moderation is an ongoing owner cost (feeds the D2 trigger).
- **Dev-mode auth bypass:** `SessionTokenMiddleware` is unenforced in Development (not a regression — all endpoints share this); the new write endpoint inherits it.
- **Endpoint rate-limiting deferred:** no per-process submission cap on `/api/feedback`; the threat is local code acting as the user (low for a local sidecar PoC), and GitHub-side secondary-rate-limit handling (§8) covers the external abuse vector.

## 12. Acceptance criteria (restated, checkable)

- [ ] A `/help` page exists, reachable from a `?` header affordance (authed) and the `/welcome` footer (first-run); explains the core workflow and each primary surface in scannable form; respects nav a11y landmarks (and `?` carries `aria-current` on `/help`); first-run reachability implemented (route is auth-agnostic).
- [ ] The guide references GitHub PAT (not Azure DevOps) and links to #213 for PAT-type detail.
- [ ] A user can initiate feedback from a discoverable in-app entry point coordinated with Help (single coherent area).
- [ ] Feedback files a GitHub issue end-to-end in `prpande/PRism-feedback` (API create when host is github.com and the PAT allows; offered prefilled-link fallback otherwise, and for first-run/GHES).
- [ ] **Machine-collected** context is allowlisted (route *pattern*, platform, version, timestamp) — no token/PR-id leak in the context block by construction; free-text fields carry an informed-consent notice.
- [ ] Error mapping distinguishes CannotCreate (offer link) / RateLimited (wait-retry) / transport-5xx (retry); 422 degrades to the link, not a 5xx.
- [ ] Entry points are coordinated (Help hub + welcome footer), not scattered.

## 13. Open decisions for the human gate

- **DEC-A — API path on the first cut, or link-only first?** Given #213's unsettled PAT guidance, the prefilled-link path may be the common case. Keeping the B2 API-create path is recommended (classic is PRism's documented recommendation, so it serves the common case and gives the no-context-switch happy path), with link as fallback. Alternative: PR2 ships link-only first and adds the API create later, deferring the B2 surface. **Spec assumes: keep the API path.**
- **DEC-B — public feedback repo with informed consent, or private?** Public is required for the fallback to collect from everyone, at the cost of public+attributed feedback and an open write surface. Mitigated by the in-dialog public-post notice. Alternative: private repo (better PII posture) — but it breaks the fallback for non-collaborators. **Spec assumes: public + notice.**
