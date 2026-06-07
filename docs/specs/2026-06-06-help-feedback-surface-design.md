# Help & Feedback surface — design

- **Issues:** [#210](https://github.com/prpande/PRism/issues/210) (Help / Guide page + nav entry), [#211](https://github.com/prpande/PRism/issues/211) (in-app bug report / feedback)
- **Tier:** T3 (slice-sized, net-new behavior, cross-tier: frontend route + dialog + new backend endpoint + GitHub write call)
- **Risk:** **Gated.** B1 (both issues carry `design`/`needs-design`) **and** B2 (a new GitHub *write* call using the user's PAT; auto-attached context handling). Human gates on spec and plan are retained; the machine `ce-doc-review` pass (run 2×) is a quality pre-pass, not a gate substitute.
- **Worktree / branch:** `D:/src/PRism-wt/210-211-help-feedback` on `feature/210-211-help-feedback`
- **Prerequisites:** (1) `prpande/PRism-feedback` exists, is **public**, issues enabled (verified). Public is a hard invariant — §4.4. (2) A real build version must be wired before the version-context field is meaningful — §4.2.

## 1. Problem

PRism ships no in-app help and no way to send feedback.

- **#210:** A new user has nowhere to learn what PRism is or how to use it. The authed chrome is `Inbox` tab + a `⚙` gear (Settings is now a modal, not a tab); there is no Help route. The only discoverability affordance is the `⌘K` cheatsheet, which lists shortcuts but explains nothing.
- **#211:** There is no affordance anywhere to report a bug or send feedback. User-encountered friction never reaches the developer unless the user *is* the developer.

The two are coupled by #211's own acceptance criterion: the feedback entry point must be **coordinated with #210 into a single coherent "get help / give feedback" area, not two scattered links.** The only *hard* coupling is **entry-point coordination** — #210 (a frontend-only B1 page) can ship and deliver value independently even if #211 (the gated B2 write path) slips in review. Designed together, phased apart (§10).

## 2. Goals / non-goals

**Goals**

1. A **static, scannable `/help` guide** reachable in *every* auth state (including first-run, when the nav is hidden).
2. A **discoverable Help entry point**: a `?` icon in the header (authed) and the existing `Help` footer stub on `/welcome` (first-run).
3. An **in-app feedback form** that files a GitHub issue in a dedicated public feedback repo, with a graceful prefilled-link fallback when the user's token can't create the issue directly.
4. **One coherent Help+Feedback area**: feedback is launched from the Help page (its primary home), plus the `/welcome` footer stub.

**Non-goals (this slice)**

- Interactive product tour / walkthrough (start static; defer).
- Auto-attaching "last error" context (no error store exists; deferred — D1).
- Category **labels** on the created issue (deferred — §4.2, D3; avoids a label-must-exist dependency on the first cut).
- A server-side feedback proxy / PRism-owned service identity (evaluated and rejected for the PoC — §4.3).
- First-class GitHub Enterprise (GHES) feedback support — best-effort only (§4.1).
- Replacing or expanding the `⌘K` cheatsheet (Help *links* to it).
- Owning PAT-type (fine-grained vs classic) guidance — that is **#213's** territory; Help links to it.

**Local-first boundary.** PRism's "local-first" promise (`WelcomePage`: *"your PAT never leaves this device"*) is a **credential/data-storage** promise: the PAT and PR data stay on-device. Feedback is an explicit, **user-initiated** action that deliberately produces public off-device state (a GitHub issue). The PAT is still used only locally by the sidecar — not exfiltrated — so the literal promise holds; the boundary is stated so the feature doesn't read as contradicting the welcome screen.

## Amendment (2026-06-07): Help is a routed MODAL, not a standalone page

Owner review of PR1's first cut (a full-page `/help`) changed the presentation: Help is now a **routed modal** that opens *over* the page behind it, mirroring the Settings modal (`SettingsModalRoutes` + the `backgroundLocation` trick), with **collapsible accordion sections** and **accent-tracking SVG section icons** (`currentColor` under a `color: var(--accent)` wrapper — not fixed-color emoji). The route, the entry points (header `?`, `/welcome` footer), the auth-agnostic reachability, and all content/copy are unchanged from the prose below — only the container changed from a page to a modal. Concretely: `HelpPage` → `HelpModal` (bespoke portal modal like `SettingsModal`) + `HelpModalRoutes` (ungated analog of `SettingsModalRoutes`); `App.tsx`'s `backgroundLocation` synthesises an auth-aware background for a cold `/help` deep-link (`/` authed, `unauthedTarget` otherwise); `useEffectiveLocation` treats `/help` like `/settings`. Wherever the text below says "page", read "modal". The diagram is updated; older "HelpPage / static page" references in §§2, 5, 10, 12 are superseded by this note.

## 3. Architecture overview

```
Header (authed)            WelcomePage (first-run)
   │ ? icon (Link→/help)      │ "Help" (Link→/help)  "Send feedback" footer
   ▼   +backgroundLocation    ▼   +backgroundLocation     │
 /help (routed modal over the background page; auth-agnostic, ungated)
   │ HelpModal — accordion sections, accent-colored icons │
   │   └─ "Send feedback" button (PR2) ───────────────────┤
   ▼                                                       ▼
        FeedbackDialog (modal, auth-adaptive)
                 │ submit
        ┌────────┴───────────────────────────────┐
   authed AND host == github.com        else (first-run, no PAT,
        │ POST /api/feedback             OR non-github.com host)
        ▼                                         │
  FeedbackEndpoint → GitHubFeedbackSubmitter      │
        │ POST api.github.com/.../PRism-feedback/issues (user PAT)
        ├─ 201 → { issueNumber, htmlUrl }          │
        └─ 403/404/422 → 422 CannotCreate ─────────┤
           (5xx/network → 500 → retry + link)      ▼
                          prefilled issues/new link → openExternal
                          (https-validated; browser github.com session files it)
```

Key property: **the prefilled-link path is both the universal fallback (authed create failed) and the primary path whenever the API can't be used (first-run, no PAT, non-github.com host).** One form, one fallback mechanism, several triggers.

## 4. Feedback transport

### 4.1 Why through the backend, and the github.com host requirement

The frontend never holds the PAT — it lives in the sidecar behind `SessionTokenMiddleware`. So an API-create must be a backend call: a new `POST /api/feedback` endpoint delegates to a new `GitHubFeedbackSubmitter` in `PRism.GitHub` that calls `POST /repos/{owner}/{repo}/issues`.

**Host resolution.** The existing `SendGitHubAsync` is a *private* member of `GitHubReviewService` bound to the **host-scoped** `"github"` HttpClient (`BaseAddress` = `HostUrlResolver.ApiBase(config.Github.Host)`). The feedback submitter therefore **cannot** call it directly and **must not** use the host-scoped client: the feedback repo lives on **github.com unconditionally**. Resolution:

- The submitter uses its own named HttpClient registered with `BaseAddress = https://api.github.com/` (mirrors how the `"github"` client is registered, keeping the outbound-host defense consistent). The shared per-request header block (Bearer, UserAgent, Accept, `X-GitHub-Api-Version`) is extracted to an `internal static` helper `(HttpRequestMessage, token)` in `PRism.GitHub` and called by both `GitHubReviewService` and the submitter, or inlined — planning decides. The spec no longer claims reuse of the private method.
- **The frontend attempts the API only when authed AND `authState.host === 'github.com'`.** For any other case (first-run/no-PAT, or a non-github.com/GHES host) it skips the API and goes straight to the prefilled-link path. Gating on the host avoids egressing an enterprise PAT to public `api.github.com` (where it would only 401 anyway) — a one-line guard with a real security rationale, not a separate code branch.
- **GHES is best-effort, not separately supported.** A GHES user reaches the github.com prefilled link, but their browser's github.com session may be a *different identity than their enterprise account, or none* (corporate policy may bar personal accounts). The "Open on GitHub" label signals it's a browser hop; we do not relabel or suppress per-host beyond that. This is an accepted PoC limitation, recorded in the non-goals.

### 4.2 Issue construction

| Field | Source | Maps to |
|-------|--------|---------|
| Category — `Bug` \| `Idea` \| `Other` | form (required, default `Bug`) | issue **title prefix** (`[Bug]`/`[Idea]`/`[Other]`). *Labels deferred — D3.* |
| Summary | form (required, ≤120 chars) | issue **title**: `[Bug] <summary>` |
| Details | form (required, multiline, ≤4000 chars) | issue **body** (top section) |
| Route pattern | frontend `useLocation` → matched route *pattern* (`/pr/:owner/:repo/:number`, **not** the concrete path) | body "Context" section |
| Platform | `typeof window.prism?.openExternal === 'function'` → `desktop`, else `browser`; plus `window.prism?.platform` when present | body "Context" section |
| App / build version | **backend-stamped** (see version note below) | body "Context" section |
| Submitted-at | backend timestamp | body "Context" section |

Body = user details, then a fenced `Context` block of the allowlisted fields.

> **Version is a prerequisite, not a given.** No `<Version>`/`<InformationalVersion>` is set in the backend csproj, so an assembly-version stamp resolves to the default `1.0.0.0` — useless for triage and inconsistent with the desktop shell's real `0.2.0`. Before this field is trusted, a real version must be wired (e.g. `Directory.Build.props <InformationalVersion>` sourced from CI/git tag) **or** the desktop `0.2.0` used as the source. Flagged as a build prerequisite.

> **`isDesktop` is not the discriminator.** Per `OpenInGitHubButton.tsx`, `window.prism.isDesktop` can be `true` on a partial desktop build with no `openExternal`. The platform field gates on the *method's* presence.

> **Field caps validated server-side too** (summary ≤120, details ≤4000 → 400 on oversize), not only in the form. Caps also bound the link-path URL budget (§4.4).

### 4.3 Why user-PAT + link fallback, not an embedded token or a proxy

- **Embedded fine-grained token (rejected):** a token shipped in the binary/code is a published secret — extractable, **auto-revoked by GitHub secret scanning** if the code/repo is ever public, un-rotatable without re-shipping, expires (≤1 yr). Violates the secrets policy. Not viable.
- **Serverless proxy (rejected for the PoC):** the correct way to get a PRism-owned identity, but adds infra + a network dependency outside the local-first model. The D2 upgrade path, triggered by volume/abuse/external-tester count.
- **User-PAT create + link fallback (chosen):** zero infra, no shipped secret. The issue is authored by the filer's GitHub account. A classic PAT (full `repo` scope) creates the issue directly; a fine-grained PAT (per-repo scoped) gets 404 → link.

**Population reality (informs DEC-A).** GitHub nudges new users toward fine-grained PATs and #213's guidance is unsettled, so the **link path may be the de-facto common path** for users at large. Its UX therefore gets first-class treatment (§5), not edge-case treatment. For PRism's *current* population — the solo owner + known testers, all directed to use classic PATs (PRism's documented recommendation) — the API path is the common path; that is the load-bearing premise behind keeping it (DEC-A, §13).

### 4.4 Prefilled-link fallback

When the API can't be used (first-run / no-PAT / non-github.com host) or returns `CannotCreate`, the frontend builds a github.com `issues/new` URL with `title` + `body` query params and opens it. The user lands on a **prefilled** New Issue page and clicks Submit there (filing via their browser's github.com session).

- **URL is constructed safely.** Build with `new URL(...)` + `URLSearchParams` (not string concatenation), then **assert `url.protocol === 'https:'` before opening**; suppress + error-toast otherwise. This blocks any `javascript:`/`data:` scheme that could otherwise be coaxed from free-text fields.
- **Opening diverges from the `OpenInGitHubButton` precedent.** That precedent is an `<a target="_blank">` whose `onClick` fires `openExternal` fire-and-forget (the anchor gives the browser fallback for free). The dialog fires **imperatively** from a button, so it must explicitly: use `window.prism.openExternal` when present, fall back to `window.open(url, '_blank')` when the bridge is absent, and `try/catch` `openExternal` to surface an error toast on throw. Don't frame it as simply "the OpenInGitHubButton pattern."
- **Offered, not automatic.** On API `CannotCreate` the dialog transitions to a confirmation state (§5) with the offered link — no unannounced tab-switch.
- **URL-length.** Bounded (~6 KB conservative cap; GitHub's tolerance is undocumented), measured on the **encoded** length (multibyte/emoji expand). When over the cap, **truncate the auto-appended Context block first**, preserving the user-authored Details; only if still over, truncate Details with a context-aware marker (`(truncated)` + "see the app" only when an API record also exists; otherwise invite adding detail directly in the issue).
- **Public-repo dependency + tradeoff.** The browser-session route needs github.com access; `prpande/PRism-feedback` is **public**, so any logged-in user can file. Cost: feedback is **public + attributed**, and the repo is an **open write surface** (spam/abuse possible). A private repo would make the fallback collect nothing for non-collaborators — incompatible with "collect from everyone." Public is kept (DEC-B), with an informed-consent notice (§5). A rate-limited classic user may find the offered link also throttled (primary limit is per-hour, shared with the browser create) — acknowledged, not a dead-end (they can retry later).

### 4.5 Configuration

The feedback repo slug defaults to `prpande/PRism-feedback`, needed by both the backend (API path) and the frontend (link URL). `/api/capabilities` carries only `{ ai }` and **no config-push channel exists**; introducing one (a new endpoint) is out of scope. So the slug is a **compile-time literal in each tier** — honestly, *two* copies (one C#, one TS), since the repo has no cross-language single-source mechanism. A future repo rename would desync them silently, so a **cross-tier test asserts the frontend link target equals the backend target** (the cheap drift guard). Codegen-from-one-source is the alternative; planning picks one. The slug is **not** user-writable (no redirect to an arbitrary repo) and **not** in `state.json` (no migration).

## 5. Frontend components

- **`/help` routed modal** (amended 2026-06-07) — `HelpModalRoutes` (an ungated analog of `SettingsModalRoutes`) matches `/help` and renders `HelpModal` over the page behind the scrim. Rendered **outside** the `isAuthed` gates so it resolves in first-run, rejected-token, and authed states. `App.tsx`'s `backgroundLocation` synthesises an auth-aware background for a cold `/help` deep-link (`/` authed, `unauthedTarget` otherwise); `useEffectiveLocation` treats `/help` like `/settings` so chrome (PrTabStrip/PrTabHost/AskAi drawer) keeps tracking the background.
- **`HelpModal`** (`components/Help/HelpModal.tsx` + `HelpModalRoutes.tsx`) — a bespoke portal modal mirroring `SettingsModal` (scrim, focus trap, Esc / scrim-click / ✕ close, focus capture+restore with an auth-aware fallback landmark). **No loading/empty state** — fully static content, bundled at build time.
  - **Hierarchy:** `<h2>Help` title; body is a vertical stack of **collapsible accordion sections** (`<button aria-expanded aria-controls>` + the shared `InboxCaret`; first section open by default). Each section header carries an **accent-tracking SVG icon** (`HelpSectionIcons`, `currentColor` under `.sectionIcon{color:var(--accent)}`). Sections, in order: what PRism is → review loop (Inbox → PR detail → submit) → main surfaces → connect/replace your **GitHub PAT** (authed → Link to Settings → GitHub connection, forwarding the page Help was opened over; unauthed → Link to `/setup`; both reference **#213** guidance) → keyboard shortcuts (`?` / `⌘/`) → Send feedback (PR2 placeholder).
  - **Copy constraints (anti-AI-slop):** each section opens with a *user task* ("To review a PR…"), not a feature blurb; surfaces named with their **exact in-app labels**; section **icons are accent-colored SVGs, not emoji**; concise, no screenshots.
  - **Content fix:** says **GitHub PAT**, never "Azure DevOps token" (#210's body is stale; the app is GitHub-only).
- **Header `?` icon** — a Link beside the `⚙` gear, rendered when `isAuthed`; navigates to `/help`; gains the active style + `aria-current="page"` when `pathname === '/help'` (mirrors `gearOn`). **Rejected-token** users (on `/setup`, `isAuthed` false) see no `?` — reachable via direct URL only, acceptable for that focused re-auth state. No always-visible `?` added (scope expansion).
- **`/welcome` footer wiring** — the two inert `<span>` stubs become real controls: `Help` → `/help`; `Send feedback` → opens `FeedbackDialog`.
- **`FeedbackDialog`** (`components/Feedback/FeedbackDialog.tsx`) — modal over the shared `Modal` (focus trap, restore-focus, `aria-modal`). The form renders **identically** in authed and link-only states; only the submit action differs.
  - **Form:** Category as a **radiogroup / segmented tabs** (#213 pattern), default `Bug`, `aria-label="Feedback category"`; Summary (text, maxlength 120); Details (textarea, maxlength 4000). A persistent notice above the submit row: **"Posted as a public GitHub issue under your account — don't include tokens, secrets, or sensitive details (internal project names, PR content)."** The Details placeholder prompts for what happened + steps, but **does not invite pasting raw logs/stack traces** (the dominant incidental-secret vector).
  - **Initial focus:** the Category group's first option (form-dialog APG convention).
  - **Validation:** submit disabled until Category, Summary, Details are all non-empty/non-whitespace.
  - **Field persistence:** form state is **not** persisted across dialog close/reopen — reopening shows a blank form.
  - **Interaction states (5):**
    1. *Idle* — submit label `Send feedback` (API path) or `Open on GitHub` (link-only path).
    2. *In-flight* (API path only) — submit disabled, label `Sending…`, fields read-only, Esc suppressed. (The link-only path is fire-and-forget: no spinner; it transitions straight to the confirmation state.)
    3. *Success* (API 201) — title → "Feedback sent"; body "Filed as #N" + an Open-in-GitHub link **using the same two-tier open strategy as §4.4**; single `Close`; Esc re-enabled; fields not re-editable.
    4. *CannotCreate / link-only* (offered link) — title → "Open on GitHub"; body explains the prefilled page opens; `Open on GitHub` (primary) builds the https-validated URL and opens it, then transitions to an "Opening GitHub…" confirmation with a single `Close` (we don't assume the github.com submit completed).
    5. *Error* (5xx/network) — inline `role="alert"` below Details; fields editable; footer `Retry` (re-fires with current values) + `Open on GitHub instead` (offered link).
  - **Esc behavior** (not a state): if any field is dirty, Esc focuses `Cancel` (mirrors `SubmitDialog`, announced via aria-live); if pristine, Esc dismisses.
  - **Focus & live-region on transitions:** on Success/CannotCreate (content replaced) focus moves to the dialog title or new primary action; on Error focus moves to the `role="alert"`. The alert is **mounted on error** (not a pre-rendered element toggled visible) so the live-region announcement fires (cf. the #197 sr-only lesson). Precise debounce/aria timing is a plan-level detail.

## 6. Backend components

- **`POST /api/feedback`** (`PRism.Web/Endpoints/FeedbackEndpoints.cs`) — DTO `{ category, summary, details, routePattern, platform }`; validates required fields **and length caps** (oversize → 400); stamps version + timestamp; calls the submitter. Returns: `201 { issueNumber, htmlUrl }`; **`422 CannotCreate`** when GitHub returns 403/404/422 (frontend → offered link); `500` for genuine transport/5xx (frontend → retry+link). No separate rate-limit code — a 403 is treated as `CannotCreate` like the rest (the link is offered; §4.4 notes it may also be throttled). One status per outcome, no `409/422`-style ambiguity.
- **`GitHubFeedbackSubmitter`** (`PRism.GitHub`) — a **package-internal class with a constructor seam** (`Func<Task<string?>> readToken`, `IHttpClientFactory`), **no `PRism.Core` interface** (single consumer, single method; the 7-method `IReviewSubmitter` earned its interface — this doesn't). Uses the `api.github.com` named client (§4.1). Builds title/body (no labels — D3). Maps `201`→`Created`; `403`/`404`/`422`→`CannotCreate`; other non-2xx→throw (→ 500). Honors Octokit/source-hygiene (no PR/issue *content* logged; structured status only).
- **Allowlist guarantee (scoped):** the **machine-collected** context (route pattern, platform, version, timestamp) is assembled from named fields only — no secret can ride along *in the context block* by construction. This does **not** extend to user-authored summary/details, which post verbatim (mitigated by the in-dialog notice, not scrubbing — §11).

## 7. Data flow

1. **Authed, github.com, token can create:** form → `POST /api/feedback` → `201` → "Filed as #N" + link. No app exit.
2. **Authed, token can't create (403/404/422):** `422 CannotCreate` → offered link → opened → user submits on github.com.
3. **Link-only (first-run/no-PAT, or non-github.com host):** form renders identically; submit skips the API and opens the prefilled link directly.
4. **Network/5xx:** error state + retry; offered link as escape hatch.

## 8. Error handling & edge cases

- **403/404/422 → `CannotCreate`** (offer link). A 422 (e.g. a missing label, were labels ever added) degrades gracefully to the link instead of a thrown 5xx. Rate-limit 403s are included — the link is offered (may also be throttled; §4.4) rather than building a dead-end "wait" state.
- **Non-github.com host** → API skipped on the frontend; link path only (§4.1).
- **External-nav safety** → `new URL()` build + `https:` assertion before opening; `openExternal` absent → `window.open(_blank)`; present-but-throws → error toast.
- **URL too long** → truncate Context block first, then Details with a context-aware marker (§4.4).
- **Empty/whitespace or oversize fields** → client disables submit; server rejects oversize with 400.
- **Route pattern** is the matched pattern, never the concrete path → no repo/PR id leak.
- **Deferred:** last-error auto-attach (no store) — D1.

## 9. Testing strategy

- **Backend (xUnit):** `GitHubFeedbackSubmitter` maps `201`/`403`/`404`/`422`/`5xx` to the correct typed results (fake HTTP handler); targets `api.github.com` regardless of configured host; body from allowlisted fields; version stamped; endpoint validation (missing/oversize → 4xx); `CannotCreate` vs `500` distinct. A **cross-tier test asserts the FE link target equals the BE feedback-repo target** (slug-drift guard). Test-first (red→green within PR history).
- **Frontend (vitest/RTL):** `FeedbackDialog` validation + each of the 5 states + Esc-dirty; authed success renders "Filed as #N"; `CannotCreate` and link-only both build an `https:` URL encoding title+body and reject a non-https build; link-only path (first-run/non-github.com host) skips the API; focus moves correctly on transitions; `HelpPage` renders sections with ids + the feedback trigger; `/help` resolves unauthed + authed; Header `?` navigates + shows active state; welcome stubs interactive.
- **e2e (Playwright):** `/help` reachable from `?` (authed) and welcome footer (first-run); dialog opens, validates, (mock) success + offered-link paths. B1 visual assert on `/help` + dialog states via screenshots on the PR.

## 10. Suggested PR phasing (for writing-plans)

- **PR1 — Help surface (#210):** `/help` + `HelpPage` + Header `?` (+ active state) + welcome `Help` link + content. Frontend-only, B1 only; **independently shippable**.
- **PR2 — Feedback pipeline (#211):** `FeedbackDialog` + welcome `Send feedback` wiring + `POST /api/feedback` + `GitHubFeedbackSubmitter` + `api.github.com` named client + link fallback + slug constant/test. Carries the B2 risk surface.

Planning owns the final breakdown.

## 11. Deferrals & residual risks

**Deferrals**
- **D1 — last-error context:** deferred (no store). Follow-up to add an error store feeding the context.
- **D2 — serverless proxy upgrade:** path to PRism-owned attribution + private repo + no browser hop. Trigger: feedback volume / abuse / external-tester count.
- **D3 — category labels:** resolved — **omit on the first cut** (category → title prefix only). Adding `bug`/`enhancement`/`feedback` labels (must pre-exist or 422) is a cosmetic follow-up; the 422→`CannotCreate` mapping is defensive if added later.
- **D4 — repo-slug carrier:** resolved — **a compile-time literal duplicated per tier with a cross-tier equality test** (or codegen; planning picks). Not a config endpoint, not a user preference, not in `state.json`.

**Residual risks (acknowledged, not blocking)**
- **Free-text exposure — two cases.** (a) *Deliberate* inclusion of a secret: the in-dialog notice helps. (b) *Incidental* — a user pastes a stack trace / HTTP dump that happens to contain a token or internal detail into a *public* issue under their real identity: the static notice does **not** prevent this, and GitHub secret-scanning only revokes recognized provider patterns (not connection strings / app secrets). Mitigations applied: the placeholder discourages raw-log pasting; broadened notice wording. A client-side secret-pattern scan is a named follow-up. The incidental case is the dominant vector and is accepted as out-of-scope-to-fully-mitigate for the PoC.
- **Prefilled URL in browser history** — the link path puts summary/details in a URL (history, address bar, possibly proxy/DLP logs) before submission.
- **Public-repo moderation surface** — any logged-in user can file via the fallback; triage/moderation is an ongoing owner cost (feeds the D2 trigger).
- **GHES feedback may be functionally unavailable** for corporate users barred from personal github.com accounts; accepted as a PoC limitation (§4.1), surfaced via the "Open on GitHub" label.
- **Dev-mode auth bypass** — `SessionTokenMiddleware` is unenforced in Development (not a regression; all endpoints share it); the new write endpoint inherits it.
- **Endpoint rate-limiting deferred** — no per-process submission cap; the threat is local code acting as the user (low for a local sidecar PoC).

## 12. Acceptance criteria (restated, checkable)

- [ ] A `/help` page exists, reachable from a `?` header affordance (authed, with `aria-current` on `/help`) and the `/welcome` footer (first-run); explains the core workflow and each primary surface in scannable form; respects nav a11y landmarks; first-run reachability implemented (route is auth-agnostic).
- [ ] The guide references GitHub PAT (not Azure DevOps) and links to #213.
- [ ] A user can initiate feedback from a discoverable in-app entry point coordinated with Help (single coherent area).
- [ ] Feedback files a GitHub issue end-to-end in `prpande/PRism-feedback` (API create when authed + github.com host + PAT allows; offered prefilled-link otherwise).
- [ ] All external navigation is `https:`-validated before opening; `CannotCreate` (403/404/422) offers the link; 5xx offers retry.
- [ ] **Machine-collected** context is allowlisted (route *pattern*, platform, version, timestamp) — no token/PR-id leak in the context block by construction; free-text fields carry the informed-consent notice.
- [ ] The feedback-repo slug is identical across tiers (asserted by a cross-tier test).
- [ ] Entry points are coordinated (Help hub + welcome footer), not scattered.

## 13. Decisions for the human gate

These were chosen during brainstorming; recorded here so the gate can override.

- **DEC-A — keep the B2 API path (decided: keep).** The link path is built regardless and serves 100% of cohorts; the API path is the slice's only write-risk surface and serves classic-PAT github.com users — for PRism's *current* population (owner + known testers on classic PATs, the documented recommendation) that is the common path, so the in-app no-context-switch create earns its place. **Rejected alternative:** ship PR2 link-only first and add the API create once #213 settles PAT guidance (defers all B2 risk; loses the in-app create for classic users). Override here if you'd rather defer the B2 surface.
- **DEC-B — public feedback repo + informed consent (decided: public).** Public is required for the browser-session fallback to collect from everyone, at the cost of public+attributed feedback and an open write surface (mitigated by the in-dialog notice). **Rejected alternative:** a private repo (better PII posture) — but it breaks the fallback for non-collaborators and undercuts "collect from everyone."
