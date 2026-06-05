# Error-box treatment for unstyled error surfaces (#182)

**Issue:** [#182](https://github.com/prpande/PRism/issues/182) — Error messages render as unstyled white text instead of a design-system error box.
**Tier / Risk:** T2 · gated **B1 (UI-visual)** — `design` label; changes rendered error output a human must eyeball. No risk-surface touched (presentational CSS/TSX only).
**Worktree / branch:** `D:/src/PRism-182-error-box` · `fix/182-error-box`.

## Problem

Several error states render as bare default-foreground text (white in dark theme), jammed top-left with no box, border, icon, or color — they read as a rendering bug, not a handled error. Two of them reference CSS classes that **do not exist** in any stylesheet:

- `PrDetailView.tsx:313` — `<div role="alert" className="pr-detail-error">` — `.pr-detail-error` is never defined → bare-text fallback. **Main offender.**
- `PrDetailView.tsx:284` — `<div role="alert" className="reload-error-banner">` — `.reload-error-banner` is never defined → same. (This site is a *dismissible reconcile banner*, not a page-error box — see migration group C.)
- `App.tsx:45` — `<div role="alert">Failed to load auth state: …</div>` — no class.
- `ErrorBoundary.tsx:27` — bare `<div role="alert">` (`<p>` message **+ Reload button**).
- `PrTabHost.tsx:66` — bare `<div role="alert">Invalid PR reference…</div>`.
- `InboxPage.tsx:42` — `<main role="alert">` error state (`<p>` message **+ Try again button**), no styling.

**Root cause.** The two undefined classes (`.pr-detail-error`, `.reload-error-banner`) were authored but never given a CSS rule; the other four sites were never styled at all. A global `.error-box` class would fix the undefined-class sites directly — but the project also wants a consistent error treatment (tinted box, leading icon) and four of these sites have *no* icon/box markup to copy from. The design system already defines `--danger-soft` / `--danger-fg` tokens (light + dark, `tokens.css:113-115,187-189`) and a `.banner-danger` strip; the surfaces that look right each independently re-roll a near-identical module `.error` rule. We introduce one component so the broken sites get the box, icon, and a11y role from a single source, and future error surfaces have a convergence target.

## Decision: a reusable `<ErrorBox>` component (message-only)

Introduce one **purely presentational** component that owns the error-box treatment — the tinted box, the leading danger icon (real inline-SVG markup, not just a class), and the `role="alert"` semantics — for **message** content. Action buttons (Reload / Try again / Dismiss) stay **outside** the component (see "A11y" for why), so `ErrorBox` models exactly one thing: a styled, announced error message.

**Scope of the consistency win (stated honestly):** this standardizes the broken message surfaces and gives the codebase a single component to converge the remaining hand-rolled `.error` rules onto later. It does **not** make every error surface consistent today — SetupForm, PasteUrlInput, and the bespoke-layout sites keep their own CSS (see audit + deferrals). The component is justified by encapsulating the **icon SVG + box CSS + role** in one place, not merely by saving a two-word `role` attribute.

**Rejected alternatives:**
- **Global CSS class** (`.error-box` sibling to `.banner`): fixes the undefined-class sites with the smallest diff, but every site must still hand-write the leading-icon SVG and its `aria-hidden` wrapper — so the icon, the chief markup the design wants, stays duplicated. The component wins specifically on bundling the icon + CSS + role, not on the `role` attribute alone.
- **Reuse the `.banner` family for everything:** `.banner` is a full-width top strip (`border-bottom` only, no rounding) — a page banner, not a contained box. Right for the dismissible reconcile banner (group C below), wrong for contained page/inline errors.

### Component API

`frontend/src/components/ErrorBox/ErrorBox.tsx`

```tsx
interface ErrorBoxProps {
  children: ReactNode;   // the message (text or inline nodes — NOT action buttons)
  className?: string;     // extra classes — preserves existing test/style hooks
}

export function ErrorBox({ children, className }: ErrorBoxProps) { … }
```

- Renders a **single element** carrying `role="alert"`, the merged `className` (module class + any passed `className`), a leading **inline `aria-hidden="true"` SVG** danger glyph, then the `children` as **direct content of that element** (no inner wrapper span — so a `getByText` in a test resolves to the role/class node itself; see Testing).
- **No props beyond `children` + `className`.** No `icon` toggle, no `size`/`variant` (YAGNI — one treatment; every current site wants the icon). Add a prop only when a real second consumer needs it.
- **Pure presentational component — no hooks, no context, no data fetching.** It must render safely inside `ErrorBoundary`'s fallback (which runs while React's render pipeline has already failed), so it cannot itself depend on anything that could throw.

### Styling

`ErrorBox.module.css`, reusing the canonical box shape already recurring across the codebase, with the review-driven width/alignment fixes:

```css
.errorBox {
  display: flex;
  align-items: flex-start;          /* icon sits at the first text line, not centered on wrapped text */
  gap: var(--s-2);
  width: fit-content;               /* don't stretch to 100vw in unconstrained (full-page) contexts */
  max-width: 100%;
  padding: var(--s-2) var(--s-3);
  background: var(--danger-soft);
  color: var(--danger-fg);
  border: 1px solid color-mix(in oklch, var(--danger-fg) 35%, transparent);  /* oklch — matches token convention */
  border-radius: var(--radius-2);
  font-size: var(--text-sm);
  line-height: 1.4;
}
.icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 1px;                  /* optical alignment to the text cap-height on line 1 */
}
```

**Icon glyph** (inline SVG in the component, no icon library — the codebase uses inline `<svg>`): a standard "alert" mark (circle with `!`), `viewBox="0 0 16 16"`, `width/height` 14, `aria-hidden="true"`, `fill="currentColor"` so it inherits `--danger-fg`. Exact path is an implementation detail; it is a single-color glyph.

Light + dark are covered by the `--danger-*` tokens. The **border tint** (`35%` mix) is **provisional** — confirmed / nudged at the B1 visual gate, together with the glyph and the full-page centering (see B1 scope below).

## Migration — three groups

**Group A — pure-message → `<ErrorBox>` (3 sites):**

| Site | Change |
|------|--------|
| `PrDetailView.tsx:313` | `<ErrorBox className="pr-detail-error">Couldn't load PR — {error.message}</ErrorBox>` — **keeps the `.pr-detail-error` test hook** |
| `App.tsx:45` | `<ErrorBox>Failed to load auth state: {error.message}</ErrorBox>` |
| `PrTabHost.tsx:66` | `<ErrorBox>Invalid PR reference: the PR number must be a positive integer.</ErrorBox>` |

**Group B — message + action button → `<ErrorBox>` for the message, button as a sibling (2 sites):**

The button stays **outside** `ErrorBox` (outside the `role="alert"` live region — see A11y). A per-site wrapper lays out the centered box + button for these full-page states.

| Site | Change |
|------|--------|
| `ErrorBoundary.tsx:27` | `<div className={styles.fallback}><ErrorBox>Something went wrong. The error has been logged.</ErrorBox><button type="button" onClick={() => window.location.reload()}>Reload</button></div>` — ErrorBoundary is a class component; importing the function component `ErrorBox` is fine. New `ErrorBoundary.module.css` `.fallback` centers the cluster. |
| `InboxPage.tsx:42` | `<main className={styles.errorState}><ErrorBox>Couldn't load inbox.</ErrorBox><button onClick={() => void reload()}>Try again</button></main>` — `role="alert"` moves **off** `<main>` onto `ErrorBox`; `<main>` stays a plain landmark. New `.errorState` in `InboxPage.module.css` (mirrors `.loading`: `display:flex; flex-direction:column; align-items:center; justify-content:center; gap; min-height:40vh`). |

**Group C — dismissible reconcile banner → existing `.banner banner-danger` strip (1 site):**

| Site | Change |
|------|--------|
| `PrDetailView.tsx:284` | `<div className="banner banner-danger" role="alert"><span>{reconcile.banner}</span><button type="button" onClick={reconcile.clearBanner}>Dismiss</button></div>` — replaces the undefined `.reload-error-banner` with the **defined** `.banner banner-danger` strip, matching the BannerRefresh/BannerTransition strips it renders alongside. Not an `ErrorBox` (it is a top-of-content dismissible notification, not a contained page error). Drop the dead `reload-error-banner` class name. |

## `role="alert"` audit — dispositions

The issue asks to "audit all `role="alert"` usages for consistency in the same pass." Full inventory and disposition:

| Site | Disposition | Reason |
|------|-------------|--------|
| `PrDetailView:313`; `App:45`; `PrTabHost:66` | **Migrate → ErrorBox (A)** | Bare/undefined-class message text. |
| `ErrorBoundary:27`; `InboxPage:42` | **Migrate → ErrorBox + sibling button (B)** | Bare message + action button. |
| `PrDetailView:284` | **Migrate → `.banner banner-danger` (C)** | Dismissible reconcile banner, not a box. |
| `SetupForm:87`, `PasteUrlInput:71` (`styles.error`) | **Defer-converge** | Already render correctly; converging changes their look (PasteUrlInput is an inline `<span>`; SetupForm has bespoke `margin`/`padding`) — visual risk on a working surface. Tracked in deferrals. |
| `FilesTab:487`, `DraftsTabError:9`, `DiscardPendingReviewConfirmationModal:56`, `DiscardAllStaleButton:143` | **Leave** | Bespoke layouts (FilesTab composes with `.banner`; DraftsTabError is a centered min-height empty-state) — not box-shaped messages; converging would distort intent. (DraftsTabError danger-color gap noted in deferrals.) |
| `WholeFileFailureBanner:8`, `StaleCommitOidBanner:25`, `CrossTabPresenceBanner:41` | **Leave** | Deliberate full-width `.banner` strips. |
| `PrRootReplyComposer:192`, `FilesTab:479` | **Leave** | Inline form/post-error affordances. |

Only genuinely-broken surfaces are migrated; convergence of the working duplicators is a follow-up (deferrals D1).

## Testing

- **`ErrorBox.test.tsx`** (new): renders `role="alert"`; renders children text (`getByText`); merges a passed `className` onto the **same** alert node (`toHaveClass('passed-class')` — assert the *passed* className, never the hashed module class, since vitest resolves CSS modules to hashes); renders the decorative icon (`container.querySelector('svg')` is non-null and `aria-hidden`).
- **`PrDetailView.freshness.test.tsx`**: the existing assertion does `getByText(/Couldn't load PR/i)` then `toHaveClass('pr-detail-error')`. This stays green **iff** the message is a direct text child of the role/class node — guaranteed by the "no inner wrapper" rule in the API. Re-run to confirm; no edit expected.
- **Group B/C tests:** add/extend a test asserting the action button renders **outside** the `role="alert"` node (e.g. the alert node's `textContent` does not include "Reload" / "Try again" / "Dismiss"), locking in the a11y structure.
- **Parity baselines** (`parity-baselines.spec.ts`): the migrated sites are error paths largely outside the happy-path baseline zones; re-capture only if a zone visibly moves. Verify during execution; re-capture affected zone(s) if so (deferrals D2).

## Accessibility

- **Buttons stay outside `role="alert"`.** `role="alert"` is an assertive live region: a screen reader announces the region's entire subtree on appearance. Keeping Reload/Try-again/Dismiss inside it would make AT read the button label as part of the alert message. ErrorBox holds the message only; the button is an adjacent, separately-focusable control.
- **Preserve, don't introduce.** All six sites already carry `role="alert"`; this change re-homes the role onto `ErrorBox` (Group A/B) or the `.banner` strip (Group C) without adding new assertive regions. Whether assertive semantics are ideal for full-page *initial-load* error states (App, InboxPage, ErrorBoundary) is a pre-existing question, not introduced here — flagged for a screen-reader spot-check at the B1 gate, not changed in this slice.
- The icon is decorative (`aria-hidden="true"`); the message text is the accessible content.
- Contrast: `--danger-soft` / `--danger-fg` are the established danger pair; the B1 gate confirms the box + border read correctly in both themes (incl. 1.4.11 non-text contrast for the border).

## B1 visual-gate scope

The gate confirms, against the real render in both themes: (1) border tint, (2) the danger glyph choice + size, (3) full-page centering for Group B (ErrorBoundary, InboxPage), and (4) a screen-reader spot-check of the assertive announcement on the full-page states. The implementer ships provisional values for 1–3 and the human confirms/nudges.

## Out of scope / deferrals

- Converging the working module-`.error` duplicators (SetupForm, PasteUrlInput) onto `<ErrorBox>` — a consistency follow-up, no user-visible defect today.
- DraftsTabError carries `role="alert"` but renders neutral (no danger color) — a separate error-signal-consistency gap, not an unstyled-text bug.
- No token changes; no new danger tokens.

See `docs/specs/2026-06-05-error-box-deferrals.md`.
