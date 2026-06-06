# Setup screen: classic vs fine-grained PAT guidance (#213)

**Status:** Design — awaiting human gate (B1 visual + auth-adjacent)
**Issue:** [#213](https://github.com/prpande/PRism/issues/213)
**Tier / Risk:** T3 / gated (B1 UI + `area:auth`)
**Scope:** Frontend only — `SetupForm.tsx` (+ CSS module), `SetupPage.tsx` error mapping, shared error-copy helper. No backend, no PAT-validation, no token-storage changes.

## Problem

The "Connect to GitHub" setup screen is **fine-grained-first** and inaccurate:

- It links only the fine-grained creation page; classic PATs get a single footnote with no link.
- The permissions table lists **"Checks: Read"**, which is **not a real fine-grained permission**.
- The error path (`SetupPage.tsx` `insufficientscopes`) hardcodes "repo / read:org" (classic language) while the happy path steers fine-grained — inconsistent.
- It never explains *which* token a user needs for their scenario, so org/enterprise users create the wrong type and get stuck.

## Verified GitHub facts (2026, against docs.github.com + GitHub changelog)

These ground every copy claim. Sources captured during brainstorming research.

1. **Fine-grained PATs are GA (Mar 2025) and enabled by default for all orgs.** An org admin can still *block* them (the org won't appear as a resource owner) or *require per-token approval* (token reads only public resources until approved). A single fine-grained token targets **one resource owner (one org)**.
2. **"Checks" is not a fine-grained permission.** The fine-grained repository-permission list has no "Checks" entry. CI signal under fine-grained comes only from **"Commit statuses" (Read)**.
3. **Fine-grained PATs cannot call the Checks API** (documented hard gap). GitHub **Actions** results surface as *check runs* → **unreadable** with a fine-grained token. Third-party CI that posts *commit statuses* still works.
4. **PRism reads check-runs.** `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs:80` calls `GET /commits/{sha}/check-runs` (plus combined commit-status at `:156`). So a fine-grained token gives PRism **no Actions CI signal** (and the unhandled non-2xx from `EnsureSuccessStatusCode()` on `:92` is a latent degradation bug — see Deferrals).
5. **Classic `repo` + `read:org` is correct** and reads **both** check-runs and commit statuses — full CI signal. Classic can also be org-blocked (403). Classic `repo` is *coarse* (full read/write to all repos).
6. **SAML SSO:** classic requires a post-creation **"Configure SSO → Authorize"** step per org; fine-grained is authorized at creation.
7. **Creation URLs (confirmed):** classic `…/settings/tokens/new`, fine-grained `…/settings/personal-access-tokens/new`.

**Consequence for the recommendation:** because PRism functionally needs the Checks API that fine-grained can't reach, **classic is PRism's recommended/primary token type**, with fine-grained offered as a clearly-caveated secondary option. This deliberately diverges from GitHub's own "fine-grained recommended" steer; the divergence is justified by PRism's check-runs dependency and is recorded as a trade-off (Rejected alternatives).

## Goals

- Present **both** PAT types accurately, each labeled as its own type, with the correct creation link and requirements.
- Make **classic the default/primary** path; **fine-grained the secondary** path carrying a concise warning about the Actions/Checks shortcoming.
- Keep the screen **compact** (no tall expansion, no awkwardly-wide card) and **coherent** with #212's changes to this screen.
- Make happy-path and error-path token guidance **consistent and token-type-aware**.

## Non-goals

- No backend changes: PAT validation, scope checks, and token storage are untouched.
- No fix for the check-runs degradation bug (see Deferrals — user decision: copy-only).
- No change to the replace-token flow's behavior beyond reusing the shared, improved error copy.
- No persistence of the selected tab (it is guidance only; the actual token type is determined by the pasted token).

## Design

A single segmented selector ("Choose a token type") drives a tabbed body, keeping a **constant, compact** vertical footprint and labeling each type so nobody confuses fine-grained permission names for classic scopes.

### Layout (the "Connect to GitHub" card)

1. **Brand:** `Connect to GitHub` + GitHub mark. **The tagline "PRism is local-first…" is removed** — it lives on `/welcome` (#212).
2. **Step 1 — "Choose a token type":** a token-type selector with two options, **Classic (default)** and **Fine-grained**, followed by the selected type's panel.
3. **Step 2 — "Paste it below":** the existing `MaskedInput`, whose **placeholder follows the selected type** — Classic → `ghp_…`, Fine-grained → `github_pat_…`.
4. **Continue** button; below it the existing replace-mode Cancel/Back affordances are unchanged.

### Token-type selector (mirrors the nav bar exactly)

Reuse the top-nav interaction pattern (`Header.module.css` `.tab` / `.tabActive`) rather than a bespoke segmented control:

- Resting: muted `--text-2`, transparent, content-width buttons with `--s-3` gap (no enclosing track).
- Hover/focus: accent glow — `--accent-hover` text + `color-mix(--accent 10%)` tint + `0 0 12px -2px --accent-ring` shadow; no underline.
- Selected: steadier `color-mix(--accent 14%)` tint + `--text-1` + weight 500.
- `--t-fast` (80ms) `--ease-out`; `prefers-reduced-motion` suppresses the transition.

**Accessibility:** implement the WAI-ARIA Tabs pattern — `role="tablist"` on the container; `role="tab"` + `aria-selected` + `aria-controls` on each button; `role="tabpanel"` + `aria-labelledby` on each panel; roving `tabindex` with Left/Right arrow navigation and Home/End; Enter/Space (and arrow-on-focus) activate. Default selection = Classic.

### Classic panel (default)

- **"Generate a classic token ↗"** → `{host}/settings/tokens/new`.
- Label **"Required scopes"** + monospace chips: `repo`, `read:org`.
- **Accent callout with org icon** (the `--accent-soft` box reused from earlier rounds): *"Using **SAML SSO**? After creating the token, click **Configure SSO → Authorize** for your organization."*

### Fine-grained panel (secondary)

- **"Generate a fine-grained token ↗"** → `{host}/settings/personal-access-tokens/new`.
- Label **"Fine-grained permissions"** + the three **valid** permissions: `Pull requests: Read and write`, `Contents: Read`, `Commit statuses: Read`. **No "Checks".**
- **Amber warning callout** (one sentence): *"Can't read **GitHub Actions** check results — Actions CI status won't show in PRism. Other CI providers still work."*
  - Reuses the **existing** warn tokens already in `tokens.css` (`--warning`, `--warning-soft`, `--warning-fg`, defined for both themes) — no new tokens. Background `--warning-soft`, text `--warning-fg`, icon `--warning`.

### Metadata note

The existing fine-grained metadata note ("Metadata: Read is auto-included… choose All/Select repositories") stays, but **only on the fine-grained panel** (it is fine-grained-specific). It is not shown on the classic panel.

### Spacing

- Section rhythm tightened to `--s-3` (12px) around the divider (from 16px); first section no top padding; **last section no bottom padding** so Continue sits close to the paste field (button keeps `--s-4` top margin).
- **No panel `min-height`.** The body reflows slightly on tab switch (fine-grained's permission list is taller than classic's single scopes row). Accepted trade-off (user decision): tighter resting layout over a pinned height that would re-introduce dead space on the default Classic tab.

### Error states (connect flow — first run)

Errors render where they do today: an inline alert pill between the paste field and Continue (`SetupForm` `.error`, `role="alert"`, `--danger-soft`/`--danger-fg`), **plus** a danger ring on the input (`aria-invalid` + `--danger` border/box-shadow) tying the error to the field.

The connect flow currently shows the **raw** `detail`/code (no friendly mapping — unlike the replace flow). Introduce a **shared, token-type-aware error-copy helper** used by both connect (inline) and replace (toast) so guidance is consistent end-to-end. Codes are the lowercased `AuthValidationError` enum.

| Code | Copy |
|------|------|
| `invalidtoken` / `validation-failed` | "GitHub rejected this token. Check that you copied the whole token, then try again." (no scope mention) |
| `insufficientscopes` | **Token-type-aware**, keyed off the *pasted token's prefix*: `ghp_*` → "This token is missing required scopes. A **classic** token needs **repo** and **read:org**."; `github_pat_*` → "This token is missing required permissions. A **fine-grained** token needs **Pull requests**, **Contents**, and **Commit statuses**." (fallback if prefix unknown: name both.) |
| `networkerror` / `dnserror` | "Couldn’t reach GitHub. Check your connection, then try again." |
| `servererror` | "GitHub returned a server error. Try again in a moment." (unchanged) |
| `submit-in-flight`, `pat-required`, `invalid-json` | unchanged (replace-flow / structural codes) |

**Token-type detection drives off the pasted token, not the selected tab** — a user can paste a classic token while the Fine-grained tab shows. The tab governs only the guidance UI and the placeholder.

## Component breakdown

- **`SetupForm.tsx`** — add `useState` for the selected token type (`'classic' | 'fine-grained'`, default `'classic'`); replace the single `PERMISSIONS`/`patPageUrl` with per-type content; render the tablist + two panels; compute the `MaskedInput` placeholder from the selected type. Derive both creation URLs from `host`. Keep the existing replace-mode Cancel logic untouched.
- **`SetupForm.module.css`** — add the selector styles (ported from the nav `.tab`/`.tabActive`), the accent org callout, the amber warning callout, the tightened section rhythm, and the input danger-ring state. Remove the obsolete `.footnote`/classic-footnote styles.
- **`SetupPage.tsx`** — route connect-flow errors through the shared error-copy helper (passing the pasted token for type detection), so the inline pill shows friendly, type-aware copy. Reuse the same helper for the replace-flow toast (generalize `replaceErrorMessage`).
- **Shared error-copy helper** — one function `tokenErrorMessage(code, pastedToken)` (location: `frontend/src/components/Setup/` or `api/`), covering all codes above. Replaces the connect path's raw passthrough and the replace path's `replaceErrorMessage`.

## Testing strategy (TDD)

Component tests (`SetupForm`):
- Default selected tab is **Classic**; classic panel shows `repo`/`read:org` chips + SSO org callout; classic link → `…/settings/tokens/new`.
- Switching to **Fine-grained** shows the three permissions, the Actions warning, and link → `…/settings/personal-access-tokens/new`.
- **No occurrence of "Checks"** anywhere in the rendered form.
- Placeholder is `ghp_…` on Classic and `github_pat_…` on Fine-grained.
- The tagline string is absent.
- Tablist a11y: `role=tab`/`aria-selected`/`aria-controls`; arrow-key navigation moves selection.

Error-copy tests (`tokenErrorMessage`):
- `invalidtoken` copy contains no "scope"/"permission" wording.
- `insufficientscopes` with a `ghp_` token names `repo`/`read:org`; with a `github_pat_` token names the three permissions; unknown prefix names both.
- `networkerror`/`dnserror`/`servererror` map as specified.
- `SetupPage` connect-flow integration: a 200-with-`ok:false` `insufficientscopes` response renders the type-aware pill (and the input shows `aria-invalid`).

E2e (Playwright) parity: update any setup-screen snapshot/spec that asserted the old fine-grained-first copy or the "Checks" row.

## Risk classification (for the human gate)

- **B1 (UI):** copy/layout a human must eyeball — visual proof required at the gate.
- **`area:auth`:** the change is **frontend copy/presentation + error-message mapping only**. It does **not** touch PAT-scope validation logic, token storage, or the connect/replace endpoints. The "auth surface" signal is satisfied at the copy level, not the validation level — flagged here for the reviewer's confirmation.
- Secrets scan: no credentials in the diff (copy + CSS + a pure mapping function).

## Rejected alternatives

- **Fine-grained as primary** (GitHub's official recommendation): rejected because PRism reads the Checks API, which fine-grained cannot access — recommending it would recommend a degraded experience. Trade-off accepted: classic `repo` is coarser (broad read/write) and we steer against GitHub's stated direction.
- **Inline progressive-disclosure (`<details>`)** and **click-to-open popover**: both reached the org/classic info without a tab, but neither keeps a constant compact footprint *and* labels the token types; the disclosure also buried the (now primary) classic path.
- **Two-column "which do I need?" chooser** and **always-visible org callout**: gave both types equal/permanent weight and widened/lengthened the card.
- **Stating the Checks-API gap as prose on the happy path / filing a degradation follow-up:** the user chose copy-only — the fine-grained warning + classic-as-default routes the affected users without explaining GitHub internals or expanding scope.
- **Pinning the panel to the taller tab's height** (no reflow): re-introduces dead space on the default Classic tab; rejected in favor of tighter resting layout.
- **Token-type-aware error keyed off the selected tab:** rejected for keying off the *pasted token's prefix*, which is what was actually validated.

## Deferrals / follow-ups

- **Latent bug (not fixed here):** `GitHubCiFailingDetector.FetchChecksAsync` calls the Checks API and `EnsureSuccessStatusCode()` will throw on a fine-grained token's non-2xx (likely 403), aborting the detect tick instead of degrading to commit-statuses-only. Per the user's copy-only decision, this is **explicitly out of scope** for #213. Candidate for a separate issue if fine-grained support is ever desired.

## Open questions

None — all of the issue's open questions resolved during brainstorming (presentation = labeled tabs; policy verified against docs; error-path aligned and made type-aware).
