---
title: Reusable accent loading spinner
issue: 125
tier: T2
risk: B1 (UI-visual, gated)
status: draft
date: 2026-06-04
---

# Reusable accent-colored loading spinner (#125)

## Problem

Loading states are inconsistent. The Inbox renders a bare top-left `Loading…`
text (`InboxPage.tsx:33`). The diff pane renders plain text loaders in **three**
places (`DiffPane.tsx`): the file-fetch branch (~L240–255), the whole-file inline
header indicator (~L518–526), and the whole-file body overlay (~L537–541,
`Loading whole file…`). There is no shared rotating spinner; the only rotating
element is a **one-off** in `DiscardPendingReviewConfirmationModal.module.css`
(`.spinner` + `@keyframes discard-pending-spin`) that nothing else can reuse.

## Goal / acceptance criteria

This slice introduces a reusable spinner and adopts it at the data-fetch screens
named in the issue (Inbox + PR-detail diff). It does **not** unify every loading
affordance in the app (see Scoping principle).

1. A single reusable accent-colored `Spinner` component exists, with unit tests.
2. The Inbox fetch state shows the spinner instead of bare `Loading…` text.
3. All three PR-detail diff loading states use the same spinner consistently.
4. Spinner color follows the selected `--accent`; `prefers-reduced-motion` is
   respected (no rotation); the loading state stays announced to assistive tech
   with a non-empty accessible name.

### Scoping principle

Full-screen / full-pane **fetch** states adopt the `Spinner`. In-button inline
affordances and separate render boundaries keep their existing treatment and are
out of scope for this slice:

- `LoadingScreen` (branded pulse-logo full-screen bootstrap) — works well, left as-is.
- `MarkAllReadButton` inline `Loading…` label — in-button micro-copy.
- The discard-modal one-off `.spinner` — also in-button; same side of the line as
  MarkAllReadButton. The new component is built to absorb it later via the
  `--spinner-color` seam (below) with no API change — tracked as a trivial
  follow-up, not done here to keep the B1 visual surface focused.
- `MarkdownFileView` (`Loading file content…`) and `MermaidBlock` /
  `MarkdownRenderer` Suspense fallbacks (`Loading diagram…`) — separate
  markdown/lazy-load boundaries, not the issue's named fetch screens. Deferred
  follow-up. (Note: `MarkdownFileView`'s loader lacks a live region today — a
  pre-existing a11y gap to fix when that surface is migrated.)

## Design

### Component

`frontend/src/components/Spinner/Spinner.tsx` (+ `Spinner.module.css`, `index.ts`).

```tsx
interface SpinnerProps {
  size?: "sm" | "md" | "lg"; // 16 / 24 / 40 px — default 'md'
  label?: string; // a11y text — default 'Loading…'
  className?: string; // layout hook for the call site (centering, margins)
}
```

Markup (repo idiom is template-literal class concatenation — there is **no**
`clsx`/`classnames`/`cx` in the codebase, so do not introduce one):

```tsx
const sizeClass = styles[size]; // 'sm' | 'md' | 'lg'
return (
  <span
    role="status"
    aria-live="polite"
    className={[styles.root, className].filter(Boolean).join(" ")}
  >
    <span className={`${styles.ring} ${sizeClass}`} aria-hidden="true" />
    <span className="sr-only">{label}</span>
  </span>
);
```

- One live region per spinner (`role="status"` + `aria-live="polite"`). The
  visible label lives in the existing global `.sr-only` util (`tokens.css:397`)
  so the ring glyph is not announced and the accessible name is `Loading…`.
- Call sites that currently set `role="status"`/`aria-live` on their own wrapper
  **remove** those attributes when delegating to `Spinner` (no nested live
  regions). See Wiring — each bullet is an explicit removal.

### Visual

Generalizes the existing discard-modal ring technique. Color is declared
**directly on the animated `.ring`** via a CSS var with an accent default, so it
is immune to ambient `color` (e.g. the `.muted` → `--text-3` on the existing
diff-pane loading span) and cannot be defeated by single-class cascade order:

```css
.ring {
  display: inline-block;
  box-sizing: border-box;
  color: var(--spinner-color, var(--accent)); /* accent default; overridable */
  border: 2px solid currentColor;
  border-top-color: transparent; /* the gap that reads as motion */
  border-radius: 50%;
  animation: spinner-rotate 0.6s linear infinite;
}
.sm {
  width: 16px;
  height: 16px;
}
.md {
  width: 24px;
  height: 24px;
}
.lg {
  width: 40px;
  height: 40px;
}

@keyframes spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}

/* Reduced motion: no rotation. Restore the full ring and convey activity with a
   gentle opacity pulse (non-vestibular) instead of a silent static circle. */
@media (prefers-reduced-motion: reduce) {
  .ring {
    border-top-color: currentColor;
    animation: spinner-pulse 1.2s ease-in-out infinite;
  }
}
@keyframes spinner-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
```

A future consumer that wants the inherited-color behavior (the discard one-off)
sets `--spinner-color: currentColor` via its `className` — no component change.

### Wiring

- **InboxPage.tsx:33** — replace `return <main aria-busy="true">Loading…</main>;`
  with a `<main>` (loading variant via `InboxPage.module.css`) containing a
  centered `<Spinner size="lg" />`. **Drop `aria-busy`** from `<main>`: with the
  Spinner's own `role="status"` inside it, `aria-busy=true` on the container can
  defer the live-region announcement on some ATs. The Spinner is the sole
  announcing element.
- **DiffPane.tsx file-fetch branch (~L240–255)** — remove the
  `<span role="status" aria-live="polite" class="diff-pane-loading muted …">`
  and render `<Spinner size="sm" />` next to the path.
- **DiffPane.tsx whole-file inline (~L518–526)** — remove the
  `<span role="status" aria-live="polite">` and render `<Spinner size="sm" />`.
- **DiffPane.tsx whole-file overlay (~L537–541)** — remove the
  `role="status" aria-live="polite"` from the overlay `<div>` and render
  `<Spinner size="md" label="Loading whole file…" />` inside it (distinct label
  preserved). Keep the overlay `<div>` for layout/positioning.

## Testing

- `Spinner.test.tsx`: renders `getByRole('status')`; the default label `Loading…`
  is present as the region's text (`within(getByRole('status')).getByText(/loading/i)`,
  not a name-scoped query — see the note below); custom `label` honored and
  non-empty; size class applied to the ring. (jsdom cannot assert CSS animation —
  that is covered by the e2e below.)
- **DiffPane loading branches have zero test coverage today** — add new coverage:
  assert the file-fetch branch renders a `role="status"` region whose label text
  matches `/loading/i`, and the overlay branch one whose text matches
  `/loading whole file/i`. Query as `within(getByRole('status')).getByText(...)`,
  **not** a name-scoped `getByRole('status', { name })`: the `status` role does
  not derive its accessible name from content, so a name-scoped query would not
  match the sr-only label. The text-within-region check still guards a dropped
  label.
- **InboxPage.test.tsx:154** currently asserts `getByText(/loading/i)`. Migrate to
  `within(getByRole('status')).getByText(/loading/i)` — scopes the text assertion
  to the live region (a bare `getByText` would also match incidental copy), while
  still failing if the label is dropped. This is the _only_ existing spec that
  asserts the literal text; the DiffPane specs do not.
- **Reduced-motion e2e** (`a11y-audit.spec.ts`, mirroring the LoadingScreen case):
  `page.emulateMedia({ reducedMotion: 'reduce' })`, render a route showing a
  spinner, assert the ring's computed `animation-duration` is `1.2s` (the pulse
  timing) rather than `0.6s` (the rotation) — CSS-modules hash the `@keyframes`
  name, so `animation-name` is not a stable assertion target across dev/prod
  builds, but the duration is. Required to evidence acceptance criterion #4.
- **Contrast check (B1 / WCAG 1.4.11 non-text 3:1):** verify the default
  `--accent` ring against the surfaces it renders on — light `--surface-0`
  (oklch L≈0.96, Inbox) and `--surface-1` (L≈0.99, diff pane) — by computing
  oklch→relative-luminance contrast. Light `--accent` is L≈0.55; dark `--accent`
  L≈0.72 on dark surfaces passes comfortably. If the light default fails 3:1,
  darken the spinner accent for light mode or document the acceptance.
- Parity baselines: the loading states are transient (not in the steady-state
  parity baselines), so no baseline re-capture is expected; confirm the parity
  suite is unaffected.

## Risks

- Nested live regions if a call site keeps its own `role="status"` — mitigated by
  the explicit removals in Wiring (all four sites).
- `aria-busy` + inner live region silencing the announcement — mitigated by
  dropping `aria-busy` on the Inbox `<main>`.
- Ambient `color` defeating an accent ring — mitigated by declaring color on
  `.ring` via `--spinner-color`/`--accent`, not relying on inheritance.
- Tests weakening to bare role existence — mitigated by asserting the label text
  _within_ the live region (`within(getByRole('status')).getByText(...)`), which
  fails if the label is dropped. (Name-scoped `getByRole('status', { name })`
  would not work here: the `status` role does not derive its name from content.)
