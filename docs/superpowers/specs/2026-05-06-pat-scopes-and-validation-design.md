# PAT scopes + validation — design

**Date:** 2026-05-06
**Slice:** patch on top of S0+S1 foundations-and-setup
**Status:** implemented in PR #5; plan at `docs/superpowers/plans/2026-05-06-pat-scopes-and-validation.md`

## Context

The Setup screen tells users to generate a fine-grained PAT (link points at `/settings/personal-access-tokens/new`) but lists the classic scope strings `repo`, `read:user`, `read:org` as required. The fine-grained PAT creation page has no field for those names — it has a permissions matrix. Worse, `GitHubReviewService.ValidateCredentialsAsync` validates by parsing the `X-OAuth-Scopes` response header, which is empty for fine-grained PATs, so a correctly-configured fine-grained PAT is rejected with `InsufficientScopes`.

The spec at `docs/spec/03-poc-features.md` § "Fine-grained PAT scope behavior" already commits to fine-grained as the primary path with classic tolerated. Spec line 28 also commits to a Search-API probe after `/user` to detect the "fine-grained PAT with no repos selected" failure mode. Neither commitment is implemented. This design closes both gaps and aligns the Setup-screen instructions to the actual fine-grained creation UI.

A separate audit of every REST + GraphQL call PRism makes (PoC slices S0–S5, plus probes) revealed that the current implementation also under-asks for permissions: Section 5 of the inbox calls the Checks API and the combined-statuses API, requiring `Checks: Read` and `Commit statuses: Read`, neither of which the Setup screen mentions.

## Decisions

1. **Fine-grained PAT is the primary path.** Classic PATs continue to work but get a one-line footnote, not equal billing.
2. **Validator branches on token prefix.** `ghp_…` → classic header check; `github_pat_…` (and any other prefix) → no header check.
3. **Validator probes Search after `/user`** for fine-grained tokens to detect the no-repos-selected case. The result is surfaced as a soft warning, not a hard failure.
4. **Setup screen renders the actual fine-grained permission rows** (Pull requests, Contents, Checks, Commit statuses) — no scope-string pills. Classic users get a single muted footnote.

## API surface — what permissions PRism actually needs

| Call | Used in | Fine-grained permission | Classic scope |
|---|---|---|---|
| `GET /user` | Setup validation | none | none |
| `GET /search/issues?q=…` | Inbox sections 1–4, Setup probe | implicit (filtered by token's repo access) | `repo`, `read:org` (SSO orgs) |
| `GET /repos/{o}/{r}/pulls/{n}` | PR detail, polling, URL paste | Pull requests: Read | `repo` |
| `GET /repos/{o}/{r}/pulls/{n}/reviews` | Awaiting-author filter | Pull requests: Read | `repo` |
| `GET /repos/{o}/{r}/pulls/{n}/comments` | PR detail, polling | Pull requests: Read | `repo` |
| `GET /repos/{o}/{r}/contents/{path}` | Diff side-content, markdown rendering | Contents: Read | `repo` |
| `GET /repos/{o}/{r}/commits/{sha}/check-runs` | Inbox section 5 | Checks: Read | `repo` |
| `GET /repos/{o}/{r}/commits/{sha}/status` | Inbox section 5 | Commit statuses: Read | `repo` |
| GraphQL `PullRequestTimelineItems` | Iteration reconstruction | Pull requests: Read | `repo` |
| GraphQL `addPullRequestReview*` / `submitPullRequestReview` | Submit pipeline | Pull requests: Write | `repo` |

### Final permission/scope sets

**Fine-grained PAT:**
- Repository access: *All repositories* or *Selected repositories* (the public-only mode cannot read private repos)
- Pull requests: Read and write
- Contents: Read
- Checks: Read
- Commit statuses: Read
- Metadata: Read — auto-included by GitHub

**Classic PAT:**
- `repo` — covers PR/review/comment/contents/checks/statuses on private + public
- `read:org` — required for SAML/SSO-enforced orgs to be visible in search results
- `read:user` — defensive; benign for users not in SSO orgs

## Validator design

`PRism.GitHub.GitHubReviewService.ValidateCredentialsAsync`:

```
1. token = await _readToken()
   if null/empty → return InvalidToken("no token")        # already correct after fix 84425ae

2. resp = await GET /user
   401      → InvalidToken("GitHub rejected this token.")
   5xx      → ServerError(...)
   non-2xx  → NetworkError(...)
   parse failure → ServerError("unparseable response body.")

3. classify token by prefix:
     ghp_…         → CLASSIC
     github_pat_…  → FINE_GRAINED
     other         → FINE_GRAINED  (most permissive)

4. If CLASSIC:
     scopes = parse(X-OAuth-Scopes)
     missing = ["repo","read:user","read:org"] - scopes
     if missing → InsufficientScopes(missing)

5. If FINE_GRAINED:
     # Spec §1 line 28: detect no-repos-selected via two Search probes.
     authored = await GET /search/issues?q=is:pr+author:@me&per_page=1
     requested = await GET /search/issues?q=is:pr+review-requested:@me&per_page=1
     if authored.total_count == 0 AND requested.total_count == 0:
        return Success { Warning = NoReposSelected, ... }
     # Either probe non-zero → token has at least some repo visibility; clear.

6. return Success(login, scopes-or-empty, Warning = None)
```

`AuthValidationResult` gains a nullable `Warning` field (enum `AuthValidationWarning { None, NoReposSelected }`). Existing callers ignore it; the connect endpoint reads it.

## Connect-flow contract

The current `POST /api/auth/connect` commits the token if validation succeeds. Honoring spec §1 line 28's "soft warning before navigation" requires deferring commit when a warning is present.

Two endpoints:

**`POST /api/auth/connect`** (existing, body `{ pat }`):
- Writes transient, validates, probes. Behavior by outcome:
  - `Ok = true, Warning = None` → commits, returns `{ ok: true, login, host }` (current behavior).
  - `Ok = true, Warning = NoReposSelected` → does **not** commit; transient retained. Returns `{ ok: true, warning: "no-repos-selected", login, host }`.
  - `Ok = false, …` → rolls back transient. Returns `{ ok: false, error, detail }` (current behavior).

**`POST /api/auth/connect/commit`** (new, no body):
- Commits the existing transient. Used by the frontend after the user clicks "Continue anyway" on the warning modal. Returns `{ ok: true }` on success, 409 if no transient is pending.

A "Cancel" action on the warning modal does not need a server call — the in-memory transient clears at process restart, and any subsequent `/connect` overwrites it. The footer "Replace token" path (existing) covers users who change their mind later.

Wire format follows the existing kebab-case enum convention. Warning field on the response is a string literal `"no-repos-selected"`.

## Setup screen design

`SetupForm.tsx` renders the fine-grained permissions as a small two-column block (label / value), not as `ScopePill`s — pills imply scope strings the user will paste somewhere, but the fine-grained UI uses dropdowns:

```
Pull requests       Read and write
Contents            Read
Checks              Read
Commit statuses     Read
```

A muted line below: *"Metadata: Read is auto-included by GitHub. For Repository access, choose All repositories or Select repositories."*

A muted footnote below the permissions block: *"Already have a classic PAT? It needs the `repo`, `read:user`, and `read:org` scopes."* All three names are inline `<code>`, not pills, and match the validator's `RequiredScopes`.

The `ScopePill` component is no longer used on the primary path. It is preserved for the classic footnote inline-code rendering pattern (or removed if the footnote uses a plain `<code>` element — implementation choice).

`SetupPage.tsx` handles the new `warning` field:
- `result.ok && !result.warning` → navigate to `/` (current behavior).
- `result.ok && result.warning === "no-repos-selected"` → render a confirmation modal: *"Your token has no repos selected. You'll see an empty inbox until you add repos at GitHub. Continue anyway?"* with **Continue anyway** and **Edit token scope** actions.
  - Continue → POST `/api/auth/connect/commit` → on success, navigate to `/`.
  - Edit → close the modal, leave the user on Setup.
- `!result.ok` → existing inline error (unchanged).

The "Generate a token" link, the textarea, and the placeholder (`ghp_… or github_pat_…`) are unchanged.

## Doc updates

- `docs/spec/03-poc-features.md` § 1 (Setup) — replace the scope-string description with the four fine-grained permissions plus the classic footnote text. Keep the spec's existing Search-probe wording at line 28 — it now matches implementation.
- `docs/spec/02-architecture.md` line 120 — already says fine-grained; verify wording is permission-shaped, not scope-shaped.
- `docs/superpowers/specs/2026-05-05-foundations-and-setup-design.md:256` — update the missing-scopes error row to note classic uses `X-OAuth-Scopes`; fine-grained skips the header check and uses Search probe instead.
- `docs/spec/00-verification-notes.md` — append a small "PAT type detection" entry: token prefix branches the validator; fine-grained tokens never return `X-OAuth-Scopes`.
- `design/handoff/README.md:118-119` — replace the three-classic-pills description with the four-permission-row description and the footnote.

## Test plan

`tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs`:
- Existing classic cases stay (assert that `ghp_…` + scoped-correctly = success; missing scopes = `InsufficientScopes`).
- New: classic + scopes correct → `Warning = None`.
- New: fine-grained `github_pat_…` + 200 + empty `X-OAuth-Scopes` + either probe `total_count > 0` → success, `Warning = None`.
- New: fine-grained + 200 + both probes `total_count == 0` → success, `Warning = NoReposSelected`.
- New: fine-grained + 401 → `InvalidToken` (probes never run).
- New: fine-grained + 200 + probe 5xx → `ServerError` (probe failures surface; do not silently downgrade).

`tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs`:
- Existing connect tests stay.
- New: `ValidateOverride` returning `Warning = NoReposSelected` → response body has `warning: "no-repos-selected"`, `ok: true`, no commit (next `auth/state` shows `hasToken: false`).
- New: `POST /api/auth/connect/commit` after a warning response commits the transient → next `auth/state` shows `hasToken: true`.
- New: `POST /api/auth/connect/commit` with no transient → 409.

`frontend/__tests__/setup-form.test.tsx`:
- Replace `read:user`/`read:org` text assertions with assertions for the four permission rows.
- Add an assertion for the classic footnote text.

`frontend/__tests__/setup-page.test.tsx`:
- New: when connect returns `warning: "no-repos-selected"`, the page renders the modal (not a redirect).
- New: clicking **Continue anyway** triggers `POST /api/auth/connect/commit` and navigates on success.
- New: clicking **Edit token scope** dismisses the modal without calling commit.

## Out of scope

- The PAT-page URL builder (already correct).
- Token storage and transient flow (already fixed in commit `84425ae`).
- The token-scope-mismatch inbox footer in `03-poc-features.md` § "Token-scope mismatch" — it remains S2 (inbox-read) territory; this design only covers Setup-time validation.
- Branch-protection-aware filtering for Section 5 — explicitly out per spec (P4).
- OAuth device flow — explicitly P4 (`docs/backlog/05-P4-polish.md`).
