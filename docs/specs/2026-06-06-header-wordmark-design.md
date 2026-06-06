# First-run header: show the “PRism” wordmark in the no-nav state (#215)

**Status:** Design — awaiting human gate (B1 visual)
**Issue:** [#215](https://github.com/prpande/PRism/issues/215)
**Tier / Risk:** T2 / gated (B1 UI — `design` / `needs-design`)
**Scope:** Frontend only — `frontend/src/components/Header/Logo.tsx` (+ `Logo.module.css`), `frontend/src/components/Header/Header.tsx`, plus migrating two existing assertions that encode the old alt-only behavior (`__tests__/header.test.tsx`, `e2e/cold-start.spec.ts` — see Testing). No backend, no routing, no data changes. Adds `.superpowers/` to `.gitignore` (brainstorm scratch dir).

## Problem

During first-run and rejected-token re-auth the header is visually empty in the middle. `Header.tsx` omits the `<nav>` tab strip when `!isAuthed` (#130) — the tabs would only bounce to `/setup` — leaving a bare logomark on the left and empty space where Inbox/Settings would be.

Worse, the **product name is never visibly shown in the header content area**. `Logo.tsx` renders only a 28×28 logomark image (`/prism-logo.png`); the name “PRism” exists solely as the image `alt` text, invisible to sighted users. (The name *does* appear in the browser tab / desktop window title — `index.html:7` `<title>PRism</title>` — so this is about the empty header *content area*, not a total brand-absence; the titlebar already covers brand recall in the authed app, which is why suppressing the header wordmark when authed leaves no gap. See Gating.) First-run is the one moment a brand-new user is meeting the product, and the now-empty nav area is the natural place to present its name.

## Verified codebase facts (against the PRism source, 2026-06-06)

These ground the design.

1. **`Header` renders in every state.** It lives in the persistent shell (`App.tsx:110`, inside `data-app-shell`) **above** the `<Routes>`, so it paints over `/welcome`, `/setup`, the Inbox, and PR-detail alike. It is *not* per-route.
2. **The two `!isAuthed` surfaces differ.** `App.tsx:100` splits unauthed users: `!hasToken` → `/welcome`, rejected-token (`hasToken && authInvalidated`) → `/setup`.
   - **`/welcome`** (`WelcomePage.tsx:24`) already shows a hero `<h1>PRism</h1>` (+ a 60px logo with `alt=""`). The header here is a thin strip over a full hero.
   - **`/setup`** (`SetupForm.tsx:100`) shows `<h1>Connect to GitHub</h1>`. **The product name appears nowhere on this screen** — this is the genuinely empty header the issue is about. Both first-run and re-auth land here.
3. **`isAuthed` is the right gate boundary.** `App.tsx:96`: `isAuthed = hasToken && !authInvalidated`. The header nav already keys off this prop (#130). The wordmark wants the same `!isAuthed` boundary, minus `/welcome` (fact 2).
4. **The logomark `alt` is `"PRism"` today** (`Logo.tsx:4`), unconditionally — so on `/welcome` the header logo `alt` *and* the hero `<h1>` already both carry “PRism”. That pre-existing double in the a11y tree is **out of scope** here (this change must not worsen it).
5. **`.spacer` (`flex: 1`) owns the middle** (`Header.module.css:64`, `Header.tsx:66`) and is unconditional, keeping the logo left-flush in the no-nav state. The wordmark sits left of the spacer, so it needs no layout restructuring.

## Goals

- Visibly show the “PRism” wordmark in the header during the no-nav state (`/setup` first-run **and** rejected-token re-auth).
- **Suppress** it on `/welcome` so the product name is not printed twice on one screen.
- When the visible wordmark is present, make the logomark decorative (`alt=""`); when absent, keep `alt="PRism"`. Couple these so they cannot drift apart.
- Preserve the #130 a11y invariant: no empty `<nav>` landmark; the wordmark is not a navigation element.
- Keep the logo-left design language; no centering, no layout reflow of existing controls.

## Non-goals

- No always-on wordmark in the authed header (rejected below). The wordmark is a no-nav-state affordance only.
- No change to the logomark image, the hero on `/welcome`, or the pre-existing `/welcome` a11y double (fact 4).
- No new shared “Brand” abstraction beyond what `Logo` already is.
- No desktop-titlebar-specific treatment (the existing drag-region CSS already covers the header; plain text is a fine drag handle).

## Design

### Gating (Option B)

Show the wordmark **iff `!isAuthed && pathname !== '/welcome'`**.

- `/setup` first-run → `!isAuthed`, not `/welcome` → **shown**. ✅ (fills the empty header)
- `/setup` rejected-token re-auth → `!isAuthed`, not `/welcome` → **shown**. ✅ (branding, harmless in re-auth)
- `/welcome` → `!isAuthed` but **is** `/welcome` → **hidden**. ✅ (hero already names the product)
- Authed (Inbox / PR / Settings) → `isAuthed` → **hidden**. ✅ (nav tabs own the space; wordmark would be redundant chrome)

`Header` already reads `useLocation()` for active-tab logic, so the `pathname` check is local and consistent with existing code — no new prop threading from `App`.

*(Rejected — Option A, gate on plain `!isAuthed`: prints a second visible “PRism” on `/welcome` competing with the hero. Rejected — Option C, always-on lockup: redundant once the user knows the product, competes with the Inbox tab + gear in the authed header, still double-paints `/welcome`, and is scope creep on a first-run issue.)*

### Component boundary — encapsulate the wordmark in `Logo`

`Logo` gains a single boolean prop and owns the **visible-text ⇄ `alt` coupling** so the two can never get out of sync:

```tsx
// Logo.tsx
interface LogoProps {
  // When true, render the visible "PRism" wordmark beside the mark and make the
  // mark decorative (alt=""), so assistive tech announces the name once. When
  // false, no visible label exists, so the mark carries the name (alt="PRism").
  showName?: boolean;
}
export function Logo({ showName = false }: LogoProps) {
  return (
    <span className={styles.lockup}>
      <img
        src="/prism-logo.png"
        alt={showName ? '' : 'PRism'}
        width={28}
        height={28}
        className={styles.logo}
      />
      {showName && <span className={styles.wordmark}>PRism</span>}
    </span>
  );
}
```

`Header` decides the boolean and stays the single source of the gating rule:

```tsx
<Logo showName={!isAuthed && pathname !== '/welcome'} />
```

The wordmark is a **plain `<span>`**, deliberately *not* an `<h1>`: the header is the `banner` landmark, and a second `<h1>` would corrupt the page’s heading outline (each page already owns its `<h1>`). It is not a nav element, so the #130 empty-`<nav>` invariant is untouched.

The lockup wrapper (`<span class="lockup">`, `inline-flex`, `gap: 8px`, `align-items: center`) is a single header flex child, so the logo + wordmark read as one unit and the header’s own 16px gap doesn’t push them apart.

### Visual treatment (V1, owner-approved)

`.wordmark`: `font-size: 16px; font-weight: 600; letter-spacing: -0.01em; line-height: 1; color: var(--text-1);` — confirmed against a visual-companion mockup using the real logo asset and the real `oklch` surface/text tokens, in both themes. `var(--text-1)` auto-adapts light/dark (light `oklch(0.20 …)`, dark `oklch(0.96 …)`). No new color tokens.

- **Font:** no `font-family` override — the wordmark inherits the body `var(--font-sans)` (Geist; `tokens.css:10`, applied at `tokens.css:333`), matching all other UI text. (If Geist hasn't loaded on first paint the fallback stack applies, identical to the rest of the chrome.)
- **Alignment:** `.lockup` is `inline-flex; align-items: center; gap: 8px`. `line-height: 1` collapses the wordmark’s line-box to its cap-height so centering the ~16px text against the 28px mark is optically predictable (this is what the mockup rendered, against an unstyled `body` line-height); without it the default ~1.2 line-box would push the text’s visual midpoint above the mark’s.
- **No overflow risk:** in the `!isAuthed` header the nav strip and the gear are *both* `isAuthed`-gated (`Header.tsx`), so neither renders; only `WindowControls` follows (desktop-only — nothing in the browser). The lockup is therefore the sole content child with the `.spacer` absorbing all slack, so it cannot be compressed. `white-space: nowrap` is set on `.wordmark` as a cheap guard so the name never wraps regardless.
- **Compact density:** `[data-density='compact']` drops `--header-h` to 48px. This is reachable on the re-auth path (a returning user’s saved density persists into the token-rejected `/setup`), not just default first-run. The 28px mark + 16px/`line-height:1` wordmark fit comfortably within 48px; no compact-specific override needed.

## Accessibility

- Exactly one visible/announced “PRism” per state where the wordmark shows: visible `<span>` text + decorative (`alt=""`) mark.
- On `/welcome` (wordmark hidden) the header keeps `alt="PRism"` — identical to today; the pre-existing hero/header double (fact 4) is neither introduced nor worsened.
- No `<nav>` landmark added; no heading added to the banner.
- No interactive control added → no new focus/keyboard surface.

## Testing (TDD — red → green within the PR)

Unit (Vitest + Testing Library), the proof for this non-bug change:

1. **`Logo` — `showName` true:** renders visible text “PRism” **and** the image has empty alt (`getByText('PRism')` present; `img` accessible name is empty).
2. **`Logo` — `showName` false (default):** no visible “PRism” text; the image’s accessible name is “PRism”.
3. **`Header` — first-run/`/setup` (`isAuthed={false}`, route `/setup`):** visible header wordmark present.
4. **`Header` — `/welcome` (`isAuthed={false}`, route `/welcome`):** **no** visible header wordmark (only the decorative mark).
5. **`Header` — authed (`isAuthed={true}`):** no visible header wordmark; nav tabs render as before.
6. **`Header` — re-auth (`isAuthed={false}`, route `/setup`):** wordmark present (same as #3; guards the re-auth path explicitly).
7. **#130 regression:** no `<nav>` element renders when `!isAuthed` (existing invariant — assert it still holds with the wordmark present).

**Migrate two existing assertions that encode the old alt-only behavior** (they go red under this change and must move with it, in the same PR):

- `__tests__/header.test.tsx:56` — the `!isAuthed` `/setup` case asserts `getByAltText('PRism')`. On `/setup` the mark now flips to `alt=""` and the name moves to the visible wordmark, so this must assert the visible wordmark (`getByText('PRism')`) instead. The authed case at `:48` (`getByAltText('PRism')` on `/`) stays — the mark keeps its alt when authed.
- `e2e/cold-start.spec.ts:57` — the `/setup` first-run case asserts `getByAltText('PRism')` (and its line-56 comment “The header logo (alt="PRism") is still present”). Update the assertion to the visible wordmark and the comment to match. The `/welcome` cases (`cold-start.spec.ts:70`, `welcome.spec.ts:48`) keep `getByAltText('PRism')` unchanged — the wordmark is suppressed there, so the mark keeps its alt.
- Any Playwright **parity baseline** that captures the `/setup` header changes (a wordmark now renders); regenerate it as part of this PR (per the repo’s Linux-baseline-via-CI-artifact process), since the e2e suite is a hard gate.

Manual / visual (B1 gate): `/setup` and `/welcome` in both light and dark themes in the running app, plus the authed Inbox header unchanged.

## Acceptance criteria

- [ ] Wordmark visible in the header on `/setup` (first-run and re-auth).
- [ ] Wordmark suppressed on `/welcome` (no duplicate visible “PRism”).
- [ ] Wordmark absent in the authed header (Inbox/PR/Settings unchanged).
- [ ] `alt=""` when the visible wordmark shows; `alt="PRism"` when it doesn’t; coupling encapsulated in `Logo`.
- [ ] No empty `<nav>` landmark reintroduced (#130).
- [ ] Verified in light and dark themes in the running app.
