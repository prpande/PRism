# Error-box treatment for unstyled error surfaces (#182)

**Issue:** [#182](https://github.com/prpande/PRism/issues/182) — Error messages render as unstyled white text instead of a design-system error box.
**Tier / Risk:** T2 · gated **B1 (UI-visual)** — `design` label; changes rendered error output a human must eyeball. No risk-surface touched (presentational CSS/TSX only).
**Worktree / branch:** `D:/src/PRism-182-error-box` · `fix/182-error-box`.

## Problem

Several error states render as bare default-foreground text (white in dark theme), jammed top-left with no box, border, icon, or color — they read as a rendering bug, not a handled error. Two of them reference CSS classes that **do not exist** in any stylesheet:

- `PrDetailView.tsx:313` — `<div role="alert" className="pr-detail-error">` — `.pr-detail-error` is never defined → bare-text fallback. **Main offender.**
- `PrDetailView.tsx:284` — `<div role="alert" className="reload-error-banner">` — `.reload-error-banner` is never defined → same. (This site is a *dismissible reconcile banner*, not a page-error box — see group C.)
- `App.tsx:45` — `<div role="alert">Failed to load auth state: …</div>` — no class, full-page (renders in place of the full-viewport LoadingScreen).
- `ErrorBoundary.tsx:27` — bare `<div role="alert">` (`<p>` message **+ Reload button**), root-level full-page fallback.
- `PrTabHost.tsx:66` — bare `<div role="alert">Invalid PR reference…</div>` (inline, alongside kept-alive tabs).
- `InboxPage.tsx:42` — `<main role="alert">` error state (`<p>` message **+ Try again button**), no styling.

**Root cause.** The two undefined classes (`.pr-detail-error`, `.reload-error-banner`) were authored but never given a CSS rule; the other four sites were never styled at all. A global `.error-box` class would fix the undefined-class sites directly — but the project also wants a consistent error treatment (tinted box, leading icon) and four of these sites have *no* icon/box markup to copy from. The design system already defines `--danger-soft` / `--danger-fg` tokens (light + dark, `tokens.css:114-115,188-189`) and a `.banner-danger` strip; the surfaces that look right each independently re-roll a near-identical module `.error` rule. We introduce one component so the broken sites get the box, icon, and a11y role from a single source, and future error surfaces have a convergence target.

## Decision: a reusable `<ErrorBox>` component (message-only)

Introduce one **purely presentational** component that owns the error-box treatment — the tinted box, the leading danger icon (real inline-SVG markup, not just a class), and the `role="alert"` semantics — for **message** content. Action buttons (Reload / Try again) stay **outside** the component (outside the assertive live region — see A11y), so `ErrorBox` models exactly one thing: a styled, announced error message.

**Scope of the consistency win (stated honestly):** this standardizes the broken message surfaces and gives the codebase a single component to converge the remaining hand-rolled `.error` rules onto later. It does **not** make every error surface consistent today — SetupForm, PasteUrlInput, and the bespoke-layout sites keep their own CSS (see audit + deferrals). The component is justified by encapsulating the **icon SVG + box CSS + role** in one place, not merely by saving a two-word `role` attribute.

**Rejected alternatives:**
- **Global CSS class** (`.error-box` sibling to `.banner`): fixes the undefined-class sites with the smallest diff, but every site must still hand-write the leading-icon SVG and its `aria-hidden` wrapper — so the icon, the chief markup the design wants, stays duplicated. The component wins specifically on bundling the icon + CSS + role.
- **Reuse the `.banner` family for everything:** `.banner` is a full-width top strip (`border-bottom` only, no rounding) — a page banner, not a contained box. Right for the dismissible reconcile banner (group C), wrong for contained page/inline errors.

### Component API

`frontend/src/components/ErrorBox/ErrorBox.tsx`

```tsx
interface ErrorBoxProps {
  children: ReactNode;   // the message (text or inline nodes — NOT action buttons)
  className?: string;     // extra classes — preserves existing test/style hooks
}

export function ErrorBox({ children, className }: ErrorBoxProps) { … }
```

- Renders a **single element** carrying `role="alert"`, the merged `className` (module class + any passed `className`), a leading **inline `aria-hidden="true"` SVG** danger glyph, then the `children` as **direct content of that element** (no inner wrapper span — so `getByText` in a test resolves to the role/class node itself; see Testing).
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

**Full-page centering (shared).** `ErrorBox` is `width: fit-content`, so on a full-page error it must be centered by its container, not by itself. Add **one global utility** to `tokens.css` (no new module file) for the two root-level full-page error states (App, ErrorBoundary), mirroring `LoadingScreen`'s `.screen`:

```css
.error-screen {            /* full-viewport centered error cluster (box + optional action button) */
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
}
```

InboxPage's error renders inside the routed content area (below the header), not at the viewport root, so it **reuses the existing `.loading` class** (`display:flex; align-items:center; justify-content:center; min-height:40vh`) rather than `.error-screen` — adding `flex-direction:column; gap` to `.loading` if needed for the box+button stack. No per-site `.fallback`/`.errorState` module class is created.

Light + dark are covered by the `--danger-*` tokens. The **border tint** (`35%` mix), the **glyph**, and the **full-page centering** are confirmed / nudged at the B1 visual gate (see B1 scope).

## Migration

**The migration discriminator is "broken/unstyled today," not shape.** A site is migrated iff it currently renders unstyled or with an undefined class. Sites that already render correctly are left or deferred even when they share a migrated site's shape (e.g. DraftsTabError has InboxPage's exact message+button shape but already styles its message — so it is a D1 convergence candidate, not a fix-now site). **Groups A/B/C below are a spec-reading shorthand for migration shape; they do not correspond to any code-level boundary or module.**

**Group A — message-only → `<ErrorBox>` (3 sites):**

| Site | Full-page? | Change |
|------|-----------|--------|
| `PrDetailView.tsx:313` | inline | `<ErrorBox className="pr-detail-error">Couldn't load PR — {error.message}</ErrorBox>` — **keeps the `.pr-detail-error` test hook** (a className-only hook; no CSS rule — add an inline `{/* test hook only — no CSS rule */}` comment so a future reader isn't confused by the dangling class). |
| `App.tsx:45` | **full-page** | `<div className="error-screen"><ErrorBox>Failed to load auth state: {error.message}</ErrorBox></div>` — wrapped in `.error-screen` (same full-viewport context as the LoadingScreen it replaces). |
| `PrTabHost.tsx:66` | inline | `<ErrorBox>Invalid PR reference: the PR number must be a positive integer.</ErrorBox>` — no wrapper; renders inline at the top of the tab host. |

**Group B — message + action button → `<ErrorBox>` for the message, button as a sibling (2 sites):**

The button stays **outside** `ErrorBox` (outside `role="alert"` — see A11y). The full-page container centers the box + button.

| Site | Change |
|------|--------|
| `ErrorBoundary.tsx:27` | `<div className="error-screen"><ErrorBox>Something went wrong. The error has been logged.</ErrorBox><button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>Reload</button></div>` — ErrorBoundary is a class component; importing the function component `ErrorBox` is fine. Uses the shared `.error-screen` (root-level, full viewport). |
| `InboxPage.tsx:42` | `<main className={styles.loading}><ErrorBox>Couldn't load inbox.</ErrorBox><button type="button" className="btn btn-secondary" onClick={() => void reload()}>Try again</button></main>` — `role="alert"` moves **off** `<main>` onto `ErrorBox`; `<main>` stays a plain landmark. Reuses the existing `.loading` class (in-page 40vh), extended with `flex-direction:column; gap` for the box+button stack. |

**Group C — dismissible reconcile banner → existing `.banner banner-danger` strip (1 site):**

| Site | Change |
|------|--------|
| `PrDetailView.tsx:284` | Replace the undefined `.reload-error-banner` with the **defined** `.banner banner-danger` strip, matching the BannerRefresh/BannerTransition strips it renders alongside, and following the established dismissible-banner markup (message `flex:1`, a styled dismiss control — mirror `InboxBanner.module.css`'s `.summary { flex:1 }` + `.dismiss`): `<div className="banner banner-danger" role="alert"><span style={{flex:1}}>{reconcile.banner}</span><button type="button" className="btn btn-ghost btn-sm" onClick={reconcile.clearBanner}>Dismiss</button></div>` (use the project's actual ghost/secondary button + dismiss class — match the sibling banners at implementation time). Drop the dead `reload-error-banner` class name. **Banners carry no leading glyph** — the danger color is the signal (consistent with the existing `.banner` strips). |

## `role="alert"` audit — dispositions

The issue asks to "audit all `role="alert"` usages for consistency in the same pass." Full inventory (17 sites) and disposition:

| Site | Disposition | Reason |
|------|-------------|--------|
| `PrDetailView:313`; `App:45`; `PrTabHost:66` | **Migrate → ErrorBox (group A)** | Bare/undefined-class message text. |
| `ErrorBoundary:27`; `InboxPage:42` | **Migrate → ErrorBox + sibling button (group B)** | Bare message + action button. |
| `PrDetailView:284` | **Migrate → `.banner banner-danger` (group C)** | Dismissible reconcile banner, not a box. |
| `SetupForm:87`, `PasteUrlInput:71` (`styles.error`) | **Defer-converge (D1)** | Already render correctly; converging changes their look (PasteUrlInput is an inline `<span>`; SetupForm has bespoke `margin`/`padding`). |
| `DraftsTabError:9` | **Defer-converge (D1)** | Same message+button shape as InboxPage but already styled (centered min-height state); broken-today discriminator → not a fix-now site. Also lacks danger color (D3). |
| `FilesTab:479`, `FilesTab:487` | **Leave** | Two branches of one diff-error ternary (range-unreachable vs other); both compose with `.banner` — not contained box messages. |
| `DiscardPendingReviewConfirmationModal:56`, `DiscardAllStaleButton:143` | **Leave** | Bespoke in-context error affordances; converging would distort intent. |
| `WholeFileFailureBanner:8`, `StaleCommitOidBanner:25`, `CrossTabPresenceBanner:41` | **Leave** | Deliberate full-width `.banner` strips. |
| `PrRootReplyComposer:192` | **Leave** | Inline form post-error affordance. |

Only genuinely-broken surfaces are migrated; convergence of the working duplicators is a follow-up (deferrals D1).

## Testing

- **`ErrorBox.test.tsx`** (new): renders `role="alert"`; renders children text (`getByText`); merges a passed `className` onto the **same** alert node (`toHaveClass('passed-class')` — assert the *passed* className, never the hashed module class, since vitest resolves CSS modules to hashes); renders the decorative icon (`container.querySelector('svg')` non-null and `aria-hidden`).
- **`PrDetailView.freshness.test.tsx`**: the existing assertion does `getByText(/Couldn't load PR/i)` then `toHaveClass('pr-detail-error')`. Stays green **iff** the message is a direct text child of the role/class node — guaranteed by the "no inner wrapper" rule. Re-run to confirm; no edit expected.
- **Group B button-placement test:** assert the **ErrorBox** (`role="alert"`) node's `textContent` does **not** include "Reload" / "Try again" — locking in that recovery buttons sit outside the assertive region. (This assertion applies to the Group A/B ErrorBox sites only — **not** Group C, whose Dismiss is intentionally inside the banner; see A11y.)
- **Parity baselines** (`parity-baselines.spec.ts`): the migrated sites are error paths largely outside the happy-path baseline zones; re-capture only if a zone visibly moves. Verify during execution; re-capture affected zone(s) if so (deferrals D2).

## Accessibility

- **Recovery buttons stay outside the page-error `role="alert"` (groups A/B).** `role="alert"` is an assertive live region: a screen reader announces the region's entire subtree on appearance. Keeping a separate recovery action (Reload / Try again) inside it would make AT read the button label as part of the alert message. ErrorBox holds the message only; the button is an adjacent, separately-focusable control. The buttons were already inside `role="alert"` today and remain Tab-reachable and self-labeled, so no programmatic association is lost by moving them out.
- **Group C is a deliberate exception.** The reconcile banner is a *persistent dismissible notification*, not a one-shot message; its Dismiss control is intrinsic to the banner and conventionally co-located, so it stays inside the strip. Whether the banner should be `role="alert"` (assertive) or `role="status"` (polite, as its working sibling `InboxBanner` uses) is the pre-existing assertiveness question below — resolved at the B1 gate, not changed in this slice.
- **Preserve, don't introduce.** All six migrated sites already carried `role="alert"`; this change re-homes the role without adding new assertive regions. Whether assertive semantics suit full-page *initial-load* error states (App, InboxPage, ErrorBoundary) is pre-existing — flagged for a screen-reader spot-check at B1 (the tester listens for exactly one announcement of the message, not the button label).
- The icon is decorative (`aria-hidden="true"`); the message text is the accessible content.
- Contrast: `--danger-soft` / `--danger-fg` are the established danger pair; the B1 gate confirms the box + border read correctly in both themes (incl. 1.4.11 non-text contrast for the border).

## B1 visual-gate scope

The gate confirms, against the real render in both themes: (1) border tint; (2) the danger glyph choice + size; (3) full-page centering for App + ErrorBoundary (`.error-screen`, viewport-centered) and InboxPage (`.loading`, in-page); (4) the Group B/C button styling (`btn btn-secondary` recovery buttons; the banner Dismiss matching its siblings); and (5) a screen-reader spot-check of the assertive announcement on the full-page states (one announcement of the message, not the button). The implementer ships provisional values for 1–4 and the human confirms/nudges.

## Out of scope / deferrals

- Converging the working module-`.error` duplicators (SetupForm, PasteUrlInput, DraftsTabError) onto `<ErrorBox>` — a consistency follow-up, no user-visible defect today.
- DraftsTabError also renders neutral (no danger color) — a separate error-signal-consistency gap.
- No token changes; no new danger tokens (the `.error-screen` utility is layout-only).

See `docs/specs/2026-06-05-error-box-deferrals.md`.
