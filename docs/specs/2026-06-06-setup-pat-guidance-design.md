# Setup screen: classic vs fine-grained PAT guidance (#213)

**Status:** Design — awaiting human gate (B1 visual + auth-adjacent)
**Issue:** [#213](https://github.com/prpande/PRism/issues/213)
**Tier / Risk:** T3 / gated (B1 UI + `area:auth`)
**Scope:** Frontend — `SetupForm.tsx` (+ CSS module), `MaskedInput.tsx` (+ CSS), `SetupPage.tsx` error mapping, a shared error-copy helper. **Plus one small backend reliability fix** (`GitHubCiFailingDetector.cs`) so a fine-grained token degrades gracefully instead of breaking inbox refresh (see Decision 1). No PAT-validation, scope-check, or token-storage changes. Also reconciles the PAT posture in `docs/spec/03-poc-features.md`.

## Problem

The "Connect to GitHub" setup screen is **fine-grained-first** and inaccurate:

- It links only the fine-grained creation page; classic PATs get a single footnote with no link.
- The permissions table lists **"Checks: Read"**, which is **not a real fine-grained permission**.
- The error path (`SetupPage.tsx` `insufficientscopes`) hardcodes "repo / read:org" while the happy path steers fine-grained — inconsistent.
- It never explains *which* token a user needs, so org/enterprise users create the wrong type and get stuck.

Deeper than the screen: PRism's data model favors classic. Fine-grained PATs are **per-org scoped**, so the inbox's Search-API sections silently hide PRs the token doesn't cover (documented in `03-poc-features.md`), and fine-grained **can't read the Checks API** PRism uses for Actions CI. The screen should therefore recommend the token type that actually works for PRism — classic — while still supporting fine-grained for users who prefer it.

## Verified GitHub & codebase facts (2026, against docs.github.com + the PRism source)

These ground every copy claim and the recommendation.

1. **Fine-grained PATs are GA (Mar 2025), enabled by default for all orgs.** An org can still *block* them (org won't appear) or *require per-token approval* (public-only until approved). A single fine-grained token targets **one resource owner (one org)**.
2. **Fine-grained PATs are per-org/per-repo scoped.** PRism's core inbox uses the Search API, which returns only repos the token can access → PRs are **silently hidden** for fine-grained users across multiple orgs (`docs/spec/03-poc-features.md`, "Fine-grained PAT scope behavior"). This affects the *whole inbox*, not just CI.
3. **"Checks" is not a fine-grained permission.** Under fine-grained, CI signal comes only from **"Commit statuses" (Read)**.
4. **Fine-grained PATs cannot call the Checks API** (documented gap). GitHub **Actions** results surface as *check runs* → unreadable with fine-grained. Third-party CI posting *commit statuses* still works.
5. **PRism reads check-runs.** `GitHubCiFailingDetector.cs:80` calls `GET /commits/{sha}/check-runs`. The non-404/429 path hits `EnsureSuccessStatusCode()` (`:92`), and `InboxRefreshOrchestrator.RefreshAsync` (`:87`) wraps the detect call (`:149`) in `try { … } finally` with **no catch** — so a thrown 403 would abort the *entire inbox refresh*, not just CI. (Addressed by Decision 1.)
6. **Classic `repo` + `read:org` is correct** and reads **both** check-runs and commit statuses, across **all** the user's orgs. Classic can be org-blocked (403). Classic `repo` is *coarse* (full read/write to all repos).
7. **`insufficientscopes` is classic-only.** `GitHubReviewService.ClassifyToken` (`:134`) routes `ghp_`→Classic, everything else→FineGrained; `InterpretAsync` (`:162`) returns `InsufficientScopes` **only** for classic (fine-grained skips the X-OAuth-Scopes check by design). A `github_pat_` token therefore can never produce `insufficientscopes` — it succeeds or returns `InvalidToken`.
8. **SAML SSO:** classic requires a post-creation **"Configure SSO → Authorize"** step per org; fine-grained is authorized at creation.
9. **Creation URLs:** classic `…/settings/tokens/new`, fine-grained `…/settings/personal-access-tokens/new`.

**Consequence for the recommendation:** the primary reason **classic is PRism's recommended/primary token type** is per-org scoping (fact 2) — a fine-grained token silently hides PRs from the core inbox for any multi-org user. The Checks/Actions gap (facts 4–5) is a secondary reason affecting Actions-based CI. This **reverses** the fine-grained-first posture currently documented in `03-poc-features.md` ("PoC documents fine-grained PAT support; classic-PAT compatibility … not guaranteed"); that doc is updated in this PR to match. The decision also diverges from GitHub's own "fine-grained recommended" steer — a deliberate, recorded trade-off (see Rejected alternatives).

## Goals

- Present **both** PAT types accurately, each labeled as its own type, with the correct creation link and requirements.
- Make **classic the default/primary** path; **fine-grained the secondary** path with a concise, *truthful* warning.
- Keep the screen **compact** and **coherent** with #212's changes to this screen.
- Make happy-path and error-path token guidance **consistent**.
- Ensure a fine-grained token never *breaks* the app — only reduces signal (Decision 1).

## Non-goals

- No change to PAT validation, scope checks, or token storage.
- No persistence of the selected token-type (it is guidance only; the pasted token is the source of truth).
- No deeper rework of fine-grained support (per-org PR-hiding UX is already handled by the existing inbox footer).

## Design

A token-type selector ("Choose a token type") drives a two-option body, keeping a **constant, compact** footprint and labeling each type so nobody confuses fine-grained permission names for classic scopes.

### Layout (the "Connect to GitHub" card)

1. **Brand:** `Connect to GitHub` + GitHub mark. **The "PRism is local-first…" tagline is removed** — it lives on `/welcome` (#212).
2. **Step 1 — "Choose a token type":** selector with **Classic (default)** and **Fine-grained**, followed by the selected type's panel.
3. **Step 2 — "Paste it below":** the existing `MaskedInput`, whose **placeholder follows the selected type** — Classic → `ghp_…`, Fine-grained → `github_pat_…`.
4. **Continue** button; existing replace-mode Cancel/Back affordances unchanged.

### Token-type selector — styled radiogroup (not an ARIA tabs widget)

Visually it reuses the top-nav pill treatment (`Header.module.css` `.tab` / `.tabActive`: muted resting text, accent-glow hover, accent-tint selected, `--t-fast` `--ease-out`, `prefers-reduced-motion` guard). **Semantically it is a radiogroup, not a tablist** — two mutually-exclusive options, not navigation between equal content views.

- Implement as a `<fieldset>` with a visually-hidden `<legend>` ("Choose a token type") containing two `<input type="radio" name="token-type">` styled as the pills (or `role="radiogroup"` + two `role="radio"` buttons if radios can't be styled cleanly). Native radios give Left/Right/Up/Down selection, `aria-checked`, and keyboard activation **for free** — no roving-tabindex code, and no `type="button"` form-submit trap.
- Default checked = **Classic**.
- The unselected panel is removed from layout and the a11y tree with `hidden` / `display:none` (also collapses it so only the active panel contributes height).

*(Rejected the full WAI-ARIA Tabs pattern with roving tabindex: disproportionate for two static options and it introduced an Enter-submits-the-form hazard inside `<form>`.)*

### Classic panel (default)

- **"Generate a classic token ↗"** → `{host}/settings/tokens/new`.
- Label **"Required scopes"** + monospace scope chips (reuse the global `.chip` token style): `repo`, `read:org`.
- **Accent callout with org icon** (the `--accent-soft` box; org/building SVG at 16px): *"Using **SAML SSO**? After creating the token, click **Configure SSO → Authorize** for your organization."*
- *(Decision 2: panel stays minimal — no write-access disclosure note.)*

### Fine-grained panel (secondary)

- **"Generate a fine-grained token ↗"** → `{host}/settings/personal-access-tokens/new`.
- Label **"Fine-grained permissions"** + the three **valid** permissions (existing `dl` grid): `Pull requests: Read and write`, `Contents: Read`, `Commit statuses: Read`. **No "Checks".**
- The existing metadata note ("Metadata: Read is auto-included… choose All/Select repositories") stays here (fine-grained-specific).
- **Amber warning callout** (warning-triangle SVG at 15px; reuses existing `--warning` / `--warning-soft` / `--warning-fg` tokens, both themes), one sentence: *"Can't read **GitHub Actions** check results — Actions CI status won't show in PRism. Other CI providers still work."* This is truthful because Decision 1 makes the missing signal a graceful degradation, not a failure.

### Spacing

- Section rhythm tightened to `--s-3` (12px) around the divider; first section no top padding; **last section no bottom padding** so Continue sits close to the paste field (button keeps `--s-4` top margin).
- **No panel `min-height`.** The body reflows on token-type switch (fine-grained's permission list is taller). Reflow is **instant — no height animation** (consistent with `prefers-reduced-motion`). Accepted trade-off (user decision): tighter resting layout over a pinned height that re-introduces dead space on the default Classic panel.

### Error states (connect flow — first run)

Errors render where they do today: an inline alert pill between the paste field and Continue (`SetupForm` `.error`, `role="alert"`, `--danger-soft`/`--danger-fg`, leading 14px danger icon — the existing `.error` `gap` already anticipates one), **plus** a danger ring on the input.

The connect flow currently shows the **raw** backend `detail`/code (no friendly mapping — unlike the replace flow, which uses `replaceErrorMessage`). Add a `connectErrorMessage(code)` for the connect path; keep `replaceErrorMessage` for the replace path; both share a private helper for the classic scopes copy. The fallback branch returns a **static** string — it must **not** echo the raw backend `code` (closes the connect-flow raw-passthrough).

| Code | Copy |
|------|------|
| `invalidtoken` / `validation-failed` | "GitHub rejected this token. Check that you copied the whole token, then try again." (no scope mention) |
| `insufficientscopes` | "This token is missing required scopes. A **classic** token needs **repo** and **read:org**." (**classic-only** — the backend never emits this for fine-grained tokens, fact 7; no fine-grained variant) |
| `networkerror` / `dnserror` | "Couldn’t reach GitHub. Check your connection, then try again." |
| `servererror` | "GitHub returned a server error. Try again in a moment." (unchanged) |
| default / unknown | "Validation failed. Check your token and try again." (static — never interpolates `code`) |
| `submit-in-flight`, `pat-required`, `invalid-json` | unchanged (replace-flow / structural codes) |

### Decision 1 — graceful CI degradation (backend)

In `GitHubCiFailingDetector.FetchChecksAsync`, treat **any non-success status** the same as the existing 404 path → return `CiStatus.None`, instead of letting `EnsureSuccessStatusCode()` throw. (Keep the explicit 429 → `RateLimitExceededException` branch, which the orchestrator handles deliberately.) This guarantees a fine-grained token on an Actions repo *loses CI signal* rather than *aborting inbox refresh*, making the fine-grained warning truthful. Mirror the same guard in `FetchCombinedStatusAsync` for symmetry.

## Component breakdown

- **`SetupForm.tsx`** — `useState` for token-type (`'classic' | 'fine-grained'`, default `'classic'`); per-type content (link, requirements, callout); compute `MaskedInput` placeholder from the type; derive both creation URLs from `host`; render the radiogroup + two panels (unselected `hidden`). Replace-mode Cancel logic untouched.
- **`SetupForm.module.css`** — radiogroup pill styles (ported from nav `.tab`/`.tabActive`), accent org callout, amber warning callout, tightened section rhythm. **Remove** the obsolete `.footnote`/classic-footnote **and `.sub`** (tagline) styles.
- **`MaskedInput.tsx` (+ `.module.css`)** — add an optional `hasError` boolean prop that sets `aria-invalid="true"` on the inner `<input>` and applies a danger-ring class (`--danger` border + soft box-shadow) gated on `[aria-invalid='true']`.
- **`SetupPage.tsx`** — route connect-flow errors through `connectErrorMessage(code)`; pass `hasError` to `MaskedInput` when an error is present.
- **Error-copy helpers** — `connectErrorMessage(code)` (connect codes) + existing `replaceErrorMessage` (replace codes), sharing a private classic-scopes-copy helper; static fallback.
- **`GitHubCiFailingDetector.cs`** — non-success → `CiStatus.None` in `FetchChecksAsync`/`FetchCombinedStatusAsync` (Decision 1).
- **`docs/spec/03-poc-features.md`** — update the PAT-posture paragraph to reflect classic-primary.

## Testing strategy (TDD)

Component (`SetupForm`):
- Default selected type is **Classic**; classic panel shows `repo`/`read:org` chips + SSO org callout; link → `…/settings/tokens/new`.
- Selecting **Fine-grained** shows the three permissions + Actions warning; link → `…/settings/personal-access-tokens/new`.
- **No "Checks"** anywhere; the tagline string is absent.
- Placeholder is `ghp_…` on Classic, `github_pat_…` on Fine-grained.
- Radiogroup a11y: two `radio`s, `aria-checked` tracks selection, arrow-key selection works, unselected panel is `hidden`.

Error copy (`connectErrorMessage`):
- `insufficientscopes` → classic `repo`/`read:org` copy (single form; no token-type branching).
- `invalidtoken` copy contains no "scope"/"permission" wording.
- `networkerror`/`dnserror`/`servererror` map as specified; unknown code → static fallback that does **not** contain the code string.
- `SetupPage` integration: a 200-with-`ok:false` `insufficientscopes` renders the pill and `MaskedInput` shows `aria-invalid`.

Backend (`GitHubCiFailingDetector`):
- `check-runs` returning 403 (and other non-2xx) → `CiStatus.None`, no throw; 429 still raises `RateLimitExceededException`. Regression-style: assert the detector swallows 403 so `RefreshAsync` completes.

E2e (Playwright): update setup-screen snapshots/specs asserting the old fine-grained-first copy or the "Checks" row.

## Risk classification (for the human gate)

- **B1 (UI):** copy/layout/error states a human must eyeball — visual proof at the gate. (Includes a dark-theme contrast check on the `--warning` callout pair, which PR #124 did not specifically verify.)
- **`area:auth`:** the frontend change is copy/presentation + error-message mapping — it does **not** touch PAT-scope validation, token storage, or the connect/replace endpoints. Note: it *removes* a raw-backend-`detail` passthrough in the connect error path (a small information-exposure improvement).
- **Backend change (Decision 1):** confined to CI-status error handling in `GitHubCiFailingDetector` — a reliability fix, not a gated risk surface (no auth/submit/migration/stamp/sidecar code). Covered by a regression test.
- Secrets scan: no credentials in the diff.

## Rejected alternatives

- **Fine-grained as primary** (GitHub's recommendation): rejected — fine-grained per-org scoping silently hides PRs from PRism's core inbox and it can't read Actions CI. Recommending it would recommend a degraded tool.
- **Over-privilege of classic `repo`:** a real cost — `repo` grants full read/write to all repos vs. fine-grained's narrow scoping, and we steer against GitHub's stated direction. Weighed and accepted because the per-org-scoping and Checks-API gaps make fine-grained functionally insufficient for PRism; per Decision 2 we do **not** add a UI disclosure note (kept the panel minimal).
- **Full WAI-ARIA Tabs widget** (roving tabindex): rejected for a styled radiogroup — simpler, native keyboard, and no in-`<form>` Enter-submit hazard.
- **Token-type-aware `insufficientscopes` copy** (the earlier demo): rejected — the backend only emits `insufficientscopes` for classic tokens, so a fine-grained variant is unreachable dead code.
- **Inline disclosure / popover / two-column chooser / always-visible callout:** earlier rounds — none kept a constant compact footprint while labeling the types.
- **Pinning the panel to the taller option's height** (no reflow): re-introduces dead space on the default Classic panel.
- **Copy-only without the Decision-1 fix:** rejected — a fine-grained token could abort inbox refresh, so no warning copy could be truthful without the graceful-degradation fix.

## Deferrals / follow-ups

- **Revisit trigger:** if GitHub adds a fine-grained Checks permission *and* relaxes per-org scoping, re-evaluate the classic-primary default (it currently steers toward the coarser, GitHub-discouraged token).

## Open questions

None — all of the issue's open questions resolved during brainstorming, verified against GitHub docs and the PRism source.
